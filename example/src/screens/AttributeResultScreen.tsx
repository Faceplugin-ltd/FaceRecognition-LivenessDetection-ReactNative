import { useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DetectedFace } from 'face-recognition-sdk';
import {
  MAX_ATTRIBUTE_FACES,
  type Candidate,
  type FaceAttributes,
} from '../data/gallery';
import { ResultStore } from '../data/resultStore';
import { totalMs } from '../data/report';
import {
  isLive,
  useSettings,
  type AppSettings,
} from '../data/settings';
import { f1, facesCount, idTag, ms, score } from '../format';
import type { RootStackParamList } from '../navigation';
import { S } from '../strings';
import { colors } from '../theme';
import {
  AttrRow,
  Card,
  CropView,
  MetricsRow,
  Pill,
  Section,
  Toolbar,
  type Badge,
} from '../ui/components';
import PersonSheet from '../ui/PersonSheet';
import StatusCard from '../ui/StatusCard';

type Props = NativeStackScreenProps<RootStackParamList, 'AttributeResult'>;

const SMILE_THRESHOLD = 0.5;
/** Mouth openness at or above which the mouth reads as open / slightly open. */
/** Eye openness on this screen is read against a fixed threshold, as on the other apps. */
const EYE_OPEN = 0.25;
const MOUTH_OPEN = 0.25;
const MOUTH_SLIGHT = 0.1;
/** Keys the cards above already show; anything else goes to "More from engine". */
const SHOWN_KEYS = new Set([
  'Age',
  'Gender',
  'Liveness2D',
  'FaceQuality',
  'EyesLeft',
  'EyesRight',
  'Emotion',
]);

const PASS: Badge = { text: S.badge_pass, color: colors.match };
const FAIL: Badge = { text: S.badge_fail, color: colors.danger };

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function hasLiveness(b: DetectedFace) {
  return !!b.livenessLabel;
}

function genderText(b: DetectedFace): string {
  if (b.genderLabel) return b.genderLabel;
  if (b.age && b.age > 0)
    return b.gender === 0 ? S.male : b.gender === 1 ? S.female : '';
  return '';
}

function emotionText(smile: number) {
  return smile >= SMILE_THRESHOLD ? S.emotion_smiling : S.emotion_neutral;
}

function livenessWord(s: AppSettings, b: DetectedFace) {
  return isLive(s, b.liveness) ? S.live : S.spoof;
}

function eyesOpen(b: DetectedFace): number | null {
  return num(b.eyes_open);
}

/** Pass/fail of each gated value the engine computed: liveness, yaw, roll, pitch, eyes. */
function gates(s: AppSettings, b: DetectedFace): boolean[] {
  const out: boolean[] = [];
  if (hasLiveness(b)) out.push(isLive(s, b.liveness));
  out.push(Math.abs(b.yaw ?? 0) <= s.yaw);
  out.push(Math.abs(b.roll ?? 0) <= s.roll);
  out.push(Math.abs(b.pitch ?? 0) <= s.pitch);
  const eo = eyesOpen(b);
  if (eo != null) out.push(eo >= EYE_OPEN);
  return out;
}

/**
 * Every face in the photo with every value the SDK returns (Android AttributeResultActivity).
 * Gated values are checked against the limits in Settings; the status card is at the bottom.
 */
export default function AttributeResultScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const s = useSettings();
  const result = ResultStore.attribute;
  const [selected, setSelected] = useState(0);
  const [sheet, setSheet] = useState<Candidate | null>(null);

  if (!result) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <Toolbar
          title={S.attribute_result_title}
          onBack={() => navigation.goBack()}
        />
      </View>
    );
  }

  const n = result.faces.length;
  const face: FaceAttributes | undefined = result.faces[selected];
  const photoW = width - 32;
  const photoH =
    result.width > 0 ? (photoW * result.height) / result.width : photoW;
  const detectMs =
    result.report.steps.find((st) => st.name === 'faceDetection')?.ms ?? 0;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Toolbar
        title={S.attribute_result_title}
        onBack={() => navigation.goBack()}
      />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 24 },
        ]}
      >
        <Card style={styles.photoCard}>
          <View style={{ width: photoW, height: photoH }}>
            <Image
              source={{ uri: result.probeUri }}
              style={{ width: photoW, height: photoH }}
            />
          </View>
        </Card>

        <View style={styles.summary}>
          <Pill
            text={n === 0 ? S.status_no_face : facesCount(n)}
            color={n === 0 ? colors.danger : colors.match}
          />
          <Text style={styles.hint}>
            {n === 0
              ? S.attr_no_face_hint
              : n > MAX_ATTRIBUTE_FACES
                ? S.attr_faces_capped(MAX_ATTRIBUTE_FACES)
                : S.attr_tap_face}
          </Text>
        </View>

        <View style={styles.gap}>
          <MetricsRow
            items={[
              { value: String(n), label: S.label_faces },
              { value: ms(detectMs), label: S.metric_detect_ms },
              { value: ms(totalMs(result.report)), label: S.metric_total_ms },
            ]}
          />
        </View>

        {n >= 2 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.gap}
          >
            {result.faces.map((f) => {
              const on = f.index === selected;
              return (
                <Pressable
                  key={f.index}
                  onPress={() => setSelected(f.index)}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {on ? '✓ ' : ''}
                    {S.face_n(f.index + 1)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {face ? (
          <FaceDetails
            face={face}
            s={s}
            probeUri={result.probeUri}
            imgW={result.width}
            imgH={result.height}
            threshold={result.threshold}
            gallerySize={result.gallerySize}
            onOpen={setSheet}
          />
        ) : (
          <Section title={S.result_title}>
            <AttrRow label={S.status} value={S.status_no_face} badge={FAIL} />
          </Section>
        )}

        <View style={styles.gap}>
          <StatusCard report={result.report} />
        </View>
      </ScrollView>
      <PersonSheet
        id={sheet?.id ?? null}
        similarity={sheet?.similarity ?? -1}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

function FaceDetails({
  face,
  s,
  probeUri,
  imgW,
  imgH,
  threshold,
  gallerySize,
  onOpen,
}: {
  face: FaceAttributes;
  s: AppSettings;
  probeUri: string;
  imgW: number;
  imgH: number;
  threshold: number;
  gallerySize: number;
  onOpen: (c: Candidate) => void;
}) {
  const b = face.box;
  const failed = gates(s, b).filter((g) => !g).length;
  const smile = num(b.smile);
  const mouth = num(b.mouth_opened);
  const eo = eyesOpen(b);
  const subtitle =
    [
      b.age && b.age > 0 ? S.age_value(b.age) : null,
      genderText(b) || null,
      smile != null ? emotionText(smile) : null,
      hasLiveness(b) ? livenessWord(s, b) : null,
    ]
      .filter((x) => x)
      .join(' · ') || S.attr_not_computed;

  const pose = (label: string, value: number, limit: number) => {
    const ok = Math.abs(value) <= limit;
    return (
      <AttrRow
        label={label}
        value={`${f1(value)}°  (±${f1(limit)}°)`}
        badge={ok ? PASS : { text: S.badge_over, color: colors.danger }}
      />
    );
  };

  const q = num(b.quality) ?? b.face_quality ?? 0;
  const qBadge: Badge =
    q < 0.5
      ? { text: S.quality_low, color: colors.danger }
      : q < 0.75
        ? { text: S.quality_medium, color: colors.nomatch }
        : { text: S.quality_high, color: colors.match };
  const det = num(b.score);

  const c = face.closest;
  const lm = b.landmarks ?? [];
  const nPoints = b.landmarkCount ?? Math.floor(lm.length / 2);
  const extra = Object.entries(b.attributes ?? {}).filter(
    ([key, v]) => !SHOWN_KEYS.has(key) && v && v.length < 400
  );

  return (
    <View>
      <Card style={[styles.header]}>
        <CropView
          uri={probeUri}
          imgW={imgW}
          imgH={imgH}
          box={b}
          size={56}
          padding={0.12}
        />
        <View style={styles.headerText}>
          <Text style={styles.faceTitle}>{S.face_n(face.index + 1)}</Text>
          <Text style={styles.faceSub}>{subtitle}</Text>
        </View>
        <Pill
          text={failed === 0 ? S.attr_all_pass : S.attr_checks_failed(failed)}
          color={failed === 0 ? colors.match : colors.nomatch}
        />
      </Card>

      <Section title={S.sec_authenticity}>
        {hasLiveness(b) ? (
          <AttrRow
            label={S.liveness_check}
            value={`${livenessWord(s, b)} · ${score(b.liveness ?? 0)}  (≥ ${score(s.livenessThreshold)})`}
            badge={isLive(s, b.liveness) ? PASS : FAIL}
            score={b.liveness ?? 0}
          />
        ) : (
          <AttrRow label={S.liveness_check} value={S.attr_not_computed} />
        )}
      </Section>

      <Section title={S.sec_person}>
        <AttrRow
          label={S.attr_age}
          value={b.age && b.age > 0 ? String(b.age) : S.attr_not_computed}
        />
        <AttrRow
          label={S.attr_gender}
          value={genderText(b) || S.attr_not_computed}
        />
      </Section>

      <Section title={S.sec_quality}>
        <AttrRow
          label={S.attr_quality}
          value={score(q)}
          badge={qBadge}
          score={q}
        />
        {det != null ? (
          <AttrRow
            label={S.attr_detection_score}
            value={score(det)}
            score={det}
          />
        ) : null}
      </Section>

      <Section title={S.sec_pose}>
        {pose(S.attr_yaw, b.yaw ?? 0, s.yaw)}
        {pose(S.attr_roll, b.roll ?? 0, s.roll)}
        {pose(S.attr_pitch, b.pitch ?? 0, s.pitch)}
      </Section>

      {/* Eyes: open score against the eye threshold from Settings, both shown as is. */}
      <Section title={S.sec_eyes}>
        {eo == null ? (
          <AttrRow label={S.attr_eyes} value={S.attr_not_computed} />
        ) : (
          <AttrRow
            label={S.attr_eyes}
            value={`${eo >= EYE_OPEN ? S.eyes_open : S.eyes_closed} · ${score(eo)}  (≥ ${score(EYE_OPEN)})`}
            badge={eo >= EYE_OPEN ? PASS : FAIL}
            score={eo}
          />
        )}
      </Section>

      <Section title={S.sec_expression}>
        {smile == null ? (
          <AttrRow label={S.attr_emotion} value={S.attr_not_computed} />
        ) : (
          <AttrRow
            label={S.attr_emotion}
            value={`${emotionText(smile)} · ${S.smile_value(score(smile))}`}
            badge={{
              text: emotionText(smile),
              color: smile >= SMILE_THRESHOLD ? colors.match : colors.info,
            }}
            score={smile}
          />
        )}
        {mouth == null ? (
          <AttrRow label={S.attr_mouth} value={S.attr_not_computed} />
        ) : (
          (() => {
            const [word, color] =
              mouth >= MOUTH_OPEN
                ? [S.mouth_open, colors.nomatch]
                : mouth >= MOUTH_SLIGHT
                  ? [S.mouth_slightly_open, colors.info]
                  : [S.mouth_closed, colors.match];
            return (
              <AttrRow
                label={S.attr_mouth}
                value={`${word} · ${score(mouth)}`}
                badge={{ text: word, color }}
                score={mouth}
              />
            );
          })()
        )}
      </Section>

      <Section title={S.sec_gallery}>
        {gallerySize === 0 ? (
          <AttrRow label={S.attr_closest} value={S.no_gallery_faces} />
        ) : face.templateBytes === 0 ? (
          <AttrRow label={S.attr_closest} value={S.attr_no_template} />
        ) : c == null ? (
          <AttrRow label={S.attr_closest} value={S.no_gallery_faces} />
        ) : (
          <AttrRow
            label={S.attr_closest}
            value={`${c.name} · ${idTag(c.id)}\n${score(c.similarity)}  (≥ ${score(threshold)})`}
            badge={
              c.similarity >= threshold
                ? { text: S.match, color: colors.match }
                : { text: S.no_match, color: colors.nomatch }
            }
            score={c.similarity}
            onPress={() => onOpen(c)}
          />
        )}
        <AttrRow
          label={S.attr_template}
          value={
            face.templateBytes > 0
              ? S.bytes_value(face.templateBytes)
              : S.attr_no_template
          }
        />
      </Section>

      <Section title={S.sec_geometry}>
        <AttrRow
          label={S.attr_box}
          value={`${b.x1}, ${b.y1} → ${b.x2}, ${b.y2}`}
        />
        <AttrRow
          label={S.attr_size}
          value={S.size_value(b.x2 - b.x1, b.y2 - b.y1)}
        />
        <AttrRow
          label={S.attr_landmarks}
          value={nPoints > 0 ? S.points_value(nPoints) : S.attr_not_computed}
        />
        {nPoints > 0 ? (
          <AttrRow
            label={S.attr_positions}
            collapsed
            value={Array.from(
              { length: nPoints },
              (_, i) =>
                `${i + 1}:  ${f1(lm[i * 2] ?? 0)}, ${f1(lm[i * 2 + 1] ?? 0)}`
            ).join('\n')}
          />
        ) : null}
      </Section>

      {extra.length > 0 ? (
        <Section title={S.sec_more}>
          {extra.map(([key, v]) => (
            <AttrRow key={key} label={key} value={v} />
          ))}
        </Section>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16 },
  photoCard: { overflow: 'hidden', alignSelf: 'center' },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  hint: { flex: 1, fontSize: 13, color: colors.onSurfaceVariant },
  gap: { marginTop: 14 },
  chip: {
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
  },
  chipOn: {
    backgroundColor: colors.secondaryContainer,
    borderColor: colors.secondaryContainer,
  },
  chipText: { fontSize: 14, color: colors.onSurfaceVariant },
  chipTextOn: { color: colors.onSecondaryContainer, fontWeight: '600' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 12,
    marginTop: 14,
  },
  headerText: { flex: 1 },
  faceTitle: { fontSize: 16, fontWeight: '600', color: colors.onSurface },
  faceSub: { fontSize: 13, color: colors.onSurfaceVariant, marginTop: 2 },
});
