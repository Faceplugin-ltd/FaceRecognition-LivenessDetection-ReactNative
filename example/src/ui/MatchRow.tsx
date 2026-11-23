import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Candidate, FaceRecord } from '../data/gallery';
import { idTag, score } from '../format';
import { colors } from '../theme';
import { ScoreBar, Tag, Thumb } from './components';

/** One match row: rank, round thumbnail, name, ID tag, similarity bar, score. */
export default function MatchRow({
  rank,
  candidate,
  record,
  onPress,
}: {
  rank: number;
  candidate: Candidate;
  record: FaceRecord | null | undefined;
  onPress: (c: Candidate) => void;
}) {
  return (
    <Pressable style={styles.row} onPress={() => onPress(candidate)}>
      <Text style={styles.rank}>{rank}</Text>
      <Thumb uri={record?.cropPath} size={44} round />
      <View style={styles.middle}>
        <View style={styles.nameLine}>
          <Text style={styles.name} numberOfLines={1}>
            {record?.name ?? candidate.name}
          </Text>
          <Tag text={idTag(candidate.id)} />
        </View>
        <ScoreBar value={candidate.similarity} style={styles.bar} />
      </View>
      <Text style={styles.score}>{score(candidate.similarity)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 12,
  },
  rank: {
    width: 20,
    textAlign: 'center',
    fontSize: 14,
    color: colors.onSurfaceVariant,
  },
  middle: { flex: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flexShrink: 1, fontSize: 15, color: colors.onSurface },
  bar: { marginTop: 6 },
  score: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.onSurface,
    fontVariant: ['tabular-nums'],
  },
});
