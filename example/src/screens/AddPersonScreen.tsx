import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { detectFaces, type DetectedFace } from 'face-recognition-sdk';
import { FaceCapture, type CaptureResult } from 'face-recognition-sdk/capture';
import * as Gallery from '../data/gallery';
import type { CallReport } from '../data/report';
import { isLive, useSettings } from '../data/settings';
import { serial } from '../engine';
import { f1, idTag, score } from '../format';
import type { RootStackParamList } from '../navigation';
import { S } from '../strings';
import { colors } from '../theme';
import {
  AttrRow,
  Button,
  Pill,
  Section,
  TextField,
  type Badge,
} from '../ui/components';
import StatusCard from '../ui/StatusCard';

type Props = NativeStackScreenProps<RootStackParamList, 'AddPerson'>;

/** What the captured still was checked for (null while checking). */
type Review = { faceCount: number; face: DetectedFace | null } | null;

const PASS: Badge = { text: S.badge_pass, color: colors.match };
const FAIL: Badge = { text: S.badge_fail, color: colors.danger };

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Add one person (Android AddPersonActivity): the Capture guide, then a review of the captured
 * still. The review lists each check with its value and the Settings limit; Name, Note, Retake
 * and Enroll show at once. Enroll is blocked while a required check fails (one face, liveness
 * when on in Settings, head pose). Low quality only warns.
 */
export default function AddPersonScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const s = useSettings();
  const [captureKey, setCaptureKey] = useState(0);
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  const [review, setReview] = useState<Review>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{
    reason: string;
    report: CallReport | null;
  } | null>(null);
  const [done, setDone] = useState<{
    title: string;
    dup: string | null;
    report: CallReport;
  } | null>(null);
  const generation = useRef(0);

  // Capture coaching uses the Settings limits and the same eye rule (open score ≥ eye threshold).
  const captureSettings = useMemo(
    () => ({
      camera_lens: 'front' as const,
      match_threshold: s.threshold,
      liveness_threshold: s.livenessThreshold,
      liveness_level: 0 as const,
      yaw_threshold: s.yaw,
      roll_threshold: s.roll,
      pitch_threshold: s.pitch,
      eyeclose_threshold: s.eye,
    }),
    [s.threshold, s.livenessThreshold, s.yaw, s.roll, s.pitch, s.eye]
  );

  /** Full attribute check of the captured still: face count + the largest face. */
  const onCaptured = async (result: CaptureResult) => {
    const g = ++generation.current;
    setCapture(result);
    setReview(null);
    setError(null);
    let faceCount = 0;
    let face: DetectedFace | null = null;
    try {
      const r = await serial(() =>
        detectFaces(result.uri, {
          liveness: true,
          quality: true,
          pose: true,
          ageGender: true,
          eyes: true,
          expression: true,
          points: true,
          sortBySize: true,
        })
      );
      faceCount = r.faces.length;
      face = r.faces[0] ?? null;
    } catch {
      faceCount = 0;
    }
    if (g === generation.current) setReview({ faceCount, face });
  };

  const retake = () => {
    if (saving) return;
    generation.current++;
    setCapture(null);
    setReview(null);
    setError(null);
    setCaptureKey((k) => k + 1);
  };

  // ---- checks ----
  const rows: ReactNode[] = [];
  const reasons: string[] = [];
  let warning: string | null = null;
  if (review) {
    const oneFace = review.faceCount === 1 && review.face != null;
    rows.push(
      <AttrRow
        key="faces"
        label={S.check_faces}
        value={String(review.faceCount)}
        badge={oneFace ? PASS : FAIL}
      />
    );
    if (!oneFace) reasons.push(S.block_faces);
    const f = review.face;
    if (f) {
      // Liveness: the Settings threshold decides; when Liveness is off it is shown, not enforced.
      const liveScore = num(f.liveness);
      if (f.livenessLabel && liveScore != null) {
        const live = isLive(s, liveScore);
        const value = `${live ? S.live : S.spoof} · ${score(liveScore)}  (≥ ${score(s.livenessThreshold)})`;
        if (s.liveness) {
          rows.push(
            <AttrRow
              key="live"
              label={S.liveness_check}
              value={value}
              badge={live ? PASS : FAIL}
              score={liveScore}
            />
          );
          if (!live) {
            reasons.push(`${S.block_liveness}\n${S.liveness_turn_off_hint}`);
          }
        } else {
          rows.push(
            <AttrRow
              key="live"
              label={S.liveness_check}
              value={S.check_liveness_off(value)}
              score={liveScore}
            />
          );
        }
      }
      // Quality warns only.
      const q = num(f.quality) ?? f.face_quality ?? 0;
      const qBadge: Badge =
        q < 0.5
          ? { text: S.quality_low, color: colors.danger }
          : q < 0.75
            ? { text: S.quality_medium, color: colors.nomatch }
            : { text: S.quality_high, color: colors.match };
      rows.push(
        <AttrRow
          key="q"
          label={S.attr_quality}
          value={score(q)}
          badge={qBadge}
          score={q}
        />
      );
      // Head pose against the Settings limits.
      const yaw = f.yaw ?? 0;
      const roll = f.roll ?? 0;
      const pitch = f.pitch ?? 0;
      const poseOk =
        Math.abs(yaw) <= s.yaw &&
        Math.abs(roll) <= s.roll &&
        Math.abs(pitch) <= s.pitch;
      const limit = Math.max(s.yaw, s.roll, s.pitch);
      rows.push(
        <AttrRow
          key="pose"
          label={S.check_pose}
          value={S.pose_value(f1(yaw), f1(roll), f1(pitch), f1(limit))}
          badge={poseOk ? PASS : { text: S.badge_over, color: colors.danger }}
        />
      );
      if (!poseOk) reasons.push(S.block_pose);
      if (reasons.length === 0 && q < 0.5) warning = S.warn_quality;
    }
  }
  const analyzed = review != null;
  const blockReason = reasons.length ? reasons.join('\n') : null;
  // The name is optional: a blank one is saved as "Person <id>", so Enroll turns on as soon
  // as the checks pass and repeat testing is capture then Enroll with no typing.
  const canEnroll = !saving && analyzed && blockReason == null && !!capture;

  // With "Skip the capture review" on, a capture that passes every check enrolls straight
  // away. One that fails still opens the review, because that is where the reason is shown.
  const skipRef = useRef(false);
  skipRef.current = s.skipReview;
  useEffect(() => {
    if (!skipRef.current || !analyzed || blockReason != null || saving) return;
    if (!capture || done || error) return;
    void enroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzed, blockReason, capture, saving]);

  const finishEnroll = () => {
    setDone(null);
    navigation.goBack();
  };

  const enroll = async () => {
    if (!canEnroll || !capture) return;
    Keyboard.dismiss();
    const n = name.trim();
    setError(null);
    setSaving(true);
    const outcome = await Gallery.enroll(n, note, capture.uri);
    setSaving(false);
    if (outcome.kind === 'enrolled') {
      const dups = outcome.duplicates;
      setDone({
        title: S.enrolled_as(outcome.record.name, outcome.record.id),
        dup: dups.length
          ? S.enroll_duplicates_warning(
              dups
                .map((d) => `${d.name} (${idTag(d.id)}) at ${score(d.similarity)}`)
                .join(', ')
            )
          : null,
        report: outcome.report,
      });
    } else {
      setError({ reason: outcome.reason, report: outcome.report });
    }
  };

  return (
    <View style={styles.root}>
      <View style={[styles.capture, { paddingTop: insets.top }]}>
        <FaceCapture
          key={captureKey}
          settings={captureSettings}
          title={S.face_capture_title}
          onCancel={() => navigation.goBack()}
          onCaptured={onCaptured}
          hideResultDetails
        />
      </View>

      {/*
        The review is the same surface as the enrolment status that follows it: a full-height
        modal, not a panel pinned under the preview. A panel has to be told how tall it is, and
        the keyboard and a short screen then both invalidate that.
      */}
      <Modal
        visible={capture != null || done != null}
        transparent
        animationType="slide"
        onRequestClose={done ? finishEnroll : retake}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.reviewScrim}
        >
          <View style={[styles.reviewSheet, { paddingTop: insets.top }]}>
            {done ? (
              <ScrollView
                contentContainerStyle={[
                  styles.panelBody,
                  { paddingBottom: insets.bottom + 16 },
                ]}
              >
                <Text style={styles.reviewTitle}>{done.title}</Text>
                {done.dup ? (
                  <Text style={[styles.reason, { color: colors.nomatch }]}>
                    {done.dup}
                  </Text>
                ) : null}
                <View style={styles.status}>
                  <StatusCard report={done.report} title={S.enroll_status_title} />
                </View>
                <Button
                  title={S.done}
                  onPress={finishEnroll}
                  style={styles.save}
                />
              </ScrollView>
            ) : (
            <ScrollView
              contentContainerStyle={[
                styles.panelBody,
                { paddingBottom: insets.bottom + 16 },
              ]}
              keyboardShouldPersistTaps="always"
            >
            <TouchableOpacity
              onPress={() => {
                retake();
                navigation.goBack();
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.reviewBack}
            >
              <Text style={styles.reviewBackText}>←</Text>
            </TouchableOpacity>
            {capture ? (
              <Image
                source={{ uri: capture.uri }}
                style={styles.reviewShot}
                resizeMode="cover"
              />
            ) : null}
            <View style={styles.reviewHead}>
              <Text style={styles.reviewTitle}>{S.capture_review_title}</Text>
              <Pill
                text={
                  !analyzed
                    ? S.capture_checking
                    : blockReason == null
                      ? S.capture_ready
                      : S.capture_retake_needed
                }
                color={
                  !analyzed
                    ? colors.info
                    : blockReason == null
                      ? colors.match
                      : colors.danger
                }
              />
            </View>
            {!analyzed ? (
              <ActivityIndicator
                color={colors.primary}
                style={styles.progress}
              />
            ) : (
              <Section title={S.sec_capture_checks}>{rows}</Section>
            )}
            {blockReason ? (
              <Text style={[styles.reason, { color: colors.danger }]}>
                {blockReason}
              </Text>
            ) : warning ? (
              <Text style={[styles.reason, { color: colors.nomatch }]}>
                {warning}
              </Text>
            ) : null}

            <TextField
              label={S.txt_name}
              value={name}
              onChangeText={(t) => {
                setName(t);
                setNameError(null);
              }}
              placeholder={S.name_hint}
              error={nameError}
            />
            <TextField
              label={S.note_optional}
              value={note}
              onChangeText={setNote}
              placeholder={S.note_hint}
            />
            {error ? <Text style={styles.error}>{error.reason}</Text> : null}
            <View style={styles.buttons}>
              <Button
                title={S.capture_retake}
                variant="outlined"
                onPress={retake}
                disabled={saving}
                style={styles.retake}
              />
              <Button
                title={saving ? S.saving : S.action_enroll}
                onPress={enroll}
                disabled={!canEnroll}
                style={styles.save}
              />
            </View>
            {error?.report ? (
              <View style={styles.status}>
                <StatusCard
                  report={error.report}
                  title={S.enroll_status_title}
                />
              </View>
            ) : null}
            </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  capture: { flex: 1 },
  reviewScrim: { flex: 1, justifyContent: 'flex-end' },
  reviewSheet: {
    flex: 1,
    backgroundColor: colors.surfaceContainer,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
  },
  reviewShot: {
    width: '100%',
    height: 220,
    borderRadius: 16,
    marginBottom: 12,
    backgroundColor: colors.black,
  },
  panel: {
    flex: 1,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  panelBody: { padding: 16 },
  reviewBack: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primaryContainer,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  reviewBackText: { color: colors.onSurface, fontSize: 22 },
  reviewHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reviewTitle: { flex: 1, fontSize: 22, color: colors.onSurface },
  progress: { marginTop: 16 },
  reason: { fontSize: 14, marginTop: 12, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 14, marginTop: 12 },
  buttons: { flexDirection: 'row', gap: 12, marginTop: 16 },
  retake: { flex: 1, height: 56, borderRadius: 28 },
  save: { flex: 2, height: 56, borderRadius: 28 },
  status: { marginTop: 16 },
});
