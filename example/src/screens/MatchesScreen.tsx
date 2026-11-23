import { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Candidate } from '../data/gallery';
import { ResultStore, allMatches } from '../data/resultStore';
import { matchesCount } from '../format';
import type { RootStackParamList } from '../navigation';
import { S } from '../strings';
import { colors } from '../theme';
import { Toolbar } from '../ui/components';
import MatchRow from '../ui/MatchRow';
import PersonSheet from '../ui/PersonSheet';
import { useRecords } from '../ui/useRecords';

type Props = NativeStackScreenProps<RootStackParamList, 'Matches'>;

/** "N more ›" target: every match at/above the threshold (Android MatchesActivity). */
export default function MatchesScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const all = ResultStore.last ? allMatches(ResultStore.last) : [];
  const records = useRecords(all.map((c) => c.id));
  const [sheet, setSheet] = useState<Candidate | null>(null);
  // Only people still in the gallery once records are loaded.
  const shown = all.filter(
    (c) => !records.has(c.id) || records.get(c.id) != null
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Toolbar
        title={S.all_matches}
        subtitle={matchesCount(shown.length)}
        onBack={() => navigation.goBack()}
      />
      <FlatList
        data={shown}
        keyExtractor={(c) => String(c.id)}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + 16 },
        ]}
        renderItem={({ item, index }) => (
          <MatchRow
            rank={index + 1}
            candidate={item}
            record={records.get(item.id)}
            onPress={setSheet}
          />
        )}
      />
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
  list: { paddingHorizontal: 16 },
});
