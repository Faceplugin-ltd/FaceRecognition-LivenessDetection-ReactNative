import { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Candidate } from '../data/gallery';
import { ResultStore, allMatches, primaryFace } from '../data/resultStore';
import { idTag, matchesCount, ms, score } from '../format';
import type { RootStackParamList } from '../navigation';
import { S } from '../strings';
import { colors } from '../theme';
import {
  Button,
  Card,
  CropView,
  MetricsRow,
  Pill,
  Tag,
  Thumb,
  Toolbar,
} from '../ui/components';
import MatchRow from '../ui/MatchRow';
import PersonSheet from '../ui/PersonSheet';
import StatusCard from '../ui/StatusCard';
import { exists, useRecords } from '../ui/useRecords';

type Props = NativeStackScreenProps<RootStackParamList, 'Result'>;

const MAX_ROWS = 3;

/** Identify result (Android ResultActivity): Match / No match, Probe vs Rank 1, metrics, matches. */
export default function ResultScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const result = ResultStore.last;
  const [sheet, setSheet] = useState<Candidate | null>(null);
  const allIds = result
    ? [
        ...result.faces
          .map((f) => f.ranked[0]?.id)
          .filter((x): x is number => x != null),
        ...allMatches(result).map((c) => c.id),
      ]
    : [];
  const records = useRecords(allIds);

  if (!result) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <Toolbar title={S.result_title} onBack={() => navigation.goBack()} />
      </View>
    );
  }

  const t = result.threshold;
  const primary = primaryFace(result);
  const top = primary.ranked[0];
  const best = top && exists(records, top.id) ? top : null;
  const matched = best != null && best.similarity >= t;
  const matches = allMatches(result).filter((c) => exists(records, c.id));
  const rec = best ? records.get(best.id) : null;
  const tile = (width - 16 * 2 - 12) / 2;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Toolbar title={S.result_title} onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 24 },
        ]}
      >
        <Pill
          text={matched ? S.match : S.no_match}
          color={matched ? colors.match : colors.nomatch}
        />

        <View style={styles.tiles}>
          <View>
            <CropView
              uri={result.probeUri}
              imgW={result.width}
              imgH={result.height}
              box={primary.box}
              size={tile}
            />
            <Text style={styles.caption}>{S.probe}</Text>
          </View>
          <Pressable onPress={() => best && setSheet(best)}>
            {/* Rank 1 shows the stored ORIGINAL photo; falls back to the crop. */}
            <Thumb
              uri={rec?.originalPath}
              fallbackUri={rec?.cropPath}
              size={tile}
            />
            <Text style={styles.caption}>{matched ? S.rank_1 : S.closest}</Text>
          </Pressable>
        </View>

        <Pressable
          style={styles.headlineRow}
          onPress={() => best && setSheet(best)}
        >
          <Text style={styles.headline} numberOfLines={2}>
            {best == null ? S.no_gallery_faces : (rec?.name ?? best.name)}
          </Text>
          {best ? <Tag text={idTag(best.id)} /> : null}
        </Pressable>
        <Text style={styles.subline}>
          {best && matched
            ? S.similarity_above(score(best.similarity), score(t))
            : S.no_face_reaches(score(t))}
        </Text>

        <View style={styles.gap}>
          <MetricsRow
            items={[
              { value: ms(result.extractMs), label: S.extract_ms },
              { value: ms(result.searchMs), label: S.search_ms },
              { value: String(result.gallerySize), label: S.gallery_size },
            ]}
          />
        </View>

        <View style={styles.gap}>
          <StatusCard report={result.report} />
        </View>

        {result.faces.length >= 2 ? (
          <Card style={[styles.gap, styles.pad]}>
            <Text style={styles.sectionTitle}>{S.probe_faces}</Text>
            {result.faces.map((f) => {
              const b =
                f.ranked[0] && exists(records, f.ranked[0].id)
                  ? f.ranked[0]
                  : null;
              const line =
                b == null
                  ? `Face ${f.index + 1} · no gallery faces`
                  : b.similarity >= t
                    ? `Face ${f.index + 1} · ${records.get(b.id)?.name ?? b.name} · ${idTag(b.id)} · ${score(b.similarity)}`
                    : `Face ${f.index + 1} · No match · closest ${score(b.similarity)}`;
              return (
                <Text
                  key={f.index}
                  style={styles.faceLine}
                  onPress={b ? () => setSheet(b) : undefined}
                >
                  {line}
                </Text>
              );
            })}
          </Card>
        ) : null}

        <Card style={[styles.gap, styles.pad]}>
          <View style={styles.matchesHead}>
            <Text style={styles.sectionTitle}>{S.matches}</Text>
            <Tag text={matchesCount(matches.length)} />
          </View>
          {matches.length === 0 ? (
            <Text style={styles.none}>{S.no_matches_row(score(t))}</Text>
          ) : null}
          {matches.slice(0, MAX_ROWS).map((c, i) => (
            <MatchRow
              key={c.id}
              rank={i + 1}
              candidate={c}
              record={records.get(c.id)}
              onPress={setSheet}
            />
          ))}
          {matches.length > MAX_ROWS ? (
            <Button
              title={S.n_more(matches.length - MAX_ROWS)}
              variant="text"
              onPress={() => navigation.navigate('Matches')}
              style={styles.more}
            />
          ) : null}
        </Card>
      </ScrollView>
      <PersonSheet
        id={sheet?.id ?? null}
        similarity={sheet?.similarity ?? -1}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16 },
  tiles: { flexDirection: 'row', gap: 12, marginTop: 16 },
  caption: { fontSize: 12, color: colors.onSurfaceVariant, marginTop: 4 },
  headlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
  },
  headline: { flexShrink: 1, fontSize: 24, color: colors.onSurface },
  subline: { fontSize: 14, color: colors.onSurfaceVariant, marginTop: 4 },
  gap: { marginTop: 16 },
  pad: { padding: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: colors.onSurface },
  faceLine: { fontSize: 14, color: colors.onSurface, marginTop: 8 },
  matchesHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  none: { fontSize: 14, color: colors.onSurfaceVariant, marginTop: 8 },
  more: { alignSelf: 'flex-end', marginTop: 4 },
});
