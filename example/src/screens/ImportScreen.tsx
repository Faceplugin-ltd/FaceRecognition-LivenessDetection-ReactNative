import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { prepareImage } from 'face-recognition-sdk';
import * as Gallery from '../data/gallery';
import type { EnrollOutcome } from '../data/gallery';
import { totalMs } from '../data/report';
import { idTag, ms, score, stripExtension } from '../format';
import type { RootStackParamList } from '../navigation';
import { S } from '../strings';
import { colors } from '../theme';
import {
  Button,
  Card,
  MetricsRow,
  Pill,
  ScoreBar,
  Tag,
  Thumb,
  Toolbar,
} from '../ui/components';
import StatusCard from '../ui/StatusCard';

type Props = NativeStackScreenProps<RootStackParamList, 'Import'>;

type Row = { key: number; fileName: string; outcome: EnrollOutcome };

/**
 * Import photos (Android ImportActivity): each photo becomes one person named after the file
 * (no extension); photos with 0 or 2+ faces are skipped with the reason.
 */
export default function ImportScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const items = [...route.params.items].sort((a, b) =>
    a.fileName.toLowerCase().localeCompare(b.fileName.toLowerCase())
  );
  const total = items.length;
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(total === 0);
  const [progress, setProgress] = useState({ i: 0, name: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    []
  );

  const enrolled = rows.filter((r) => r.outcome.kind === 'enrolled').length;
  const skipped = rows.length - enrolled;
  const sumMs = rows.reduce(
    (a, r) => a + (r.outcome.report ? totalMs(r.outcome.report) : 0),
    0
  );

  const start = async () => {
    setStarted(true);
    for (let i = 0; i < items.length; i++) {
      if (cancelled.current) return;
      const item = items[i]!;
      setProgress({ i: i + 1, name: item.fileName });
      let outcome: EnrollOutcome;
      try {
        const prepared = await prepareImage(item.uri, 1280);
        outcome = await Gallery.enroll(
          stripExtension(item.fileName),
          '',
          prepared.uri
        );
      } catch {
        outcome = {
          kind: 'rejected',
          reason: S.photo_unreadable,
          report: null,
        };
      }
      if (cancelled.current) return;
      setRows((r) => [{ key: i, fileName: item.fileName, outcome }, ...r]);
    }
    setProgress({ i: total, name: S.done });
    setFinished(true);
  };

  const toggle = (key: number) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Toolbar title={S.import_title} onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 24 },
        ]}
      >
        <Text style={styles.summary}>
          {total === 0
            ? S.no_images_found
            : total === 1
              ? S.import_summary_one
              : S.import_summary(total)}
        </Text>
        {!started ? <Text style={styles.rules}>{S.import_rules}</Text> : null}

        {started ? (
          <View style={styles.gap}>
            <ScoreBar
              value={total ? progress.i / total : 0}
              style={styles.progress}
            />
            <Text style={styles.progressText}>
              {S.import_progress(progress.i, total, progress.name)}
            </Text>
          </View>
        ) : null}

        {started ? (
          <View style={styles.gap}>
            <MetricsRow
              items={[
                { value: String(enrolled), label: S.label_enrolled },
                { value: String(skipped), label: S.label_skipped },
                {
                  value: rows.length === 0 ? '–' : ms(sumMs / rows.length),
                  label: S.metric_avg_ms,
                },
              ]}
            />
          </View>
        ) : null}

        {finished && started ? (
          <Text style={styles.done}>{S.import_done(enrolled, skipped)}</Text>
        ) : null}

        <Button
          title={finished ? S.done : S.start_import}
          onPress={() => (finished ? navigation.goBack() : start())}
          disabled={started && !finished}
          style={styles.gap}
        />

        {rows.length > 0 ? (
          <Card style={[styles.gap, styles.results]}>
            <View style={styles.resultsHead}>
              <Text style={styles.resultsTitle}>{S.import_results}</Text>
              <Tag text={String(rows.length)} />
            </View>
            {rows.map((r) => {
              const o = r.outcome;
              const ok = o.kind === 'enrolled';
              // Every "looks like", not just the closest: one imported face can match
              // several people already in the gallery.
              const dups = o.kind === 'enrolled' ? o.duplicates : [];
              const sub =
                o.kind === 'enrolled'
                  ? `${o.record.name} · ${idTag(o.record.id)}` +
                    (dups.length
                      ? ` · ${S.step_duplicate}: ` +
                        dups
                          .map((d) => `${d.name} ${score(d.similarity)}`)
                          .join(', ')
                      : '')
                  : o.reason;
              const report = o.report;
              return (
                <View key={r.key}>
                  <Pressable
                    style={styles.row}
                    onPress={() => report && toggle(r.key)}
                  >
                    <Thumb
                      uri={o.kind === 'enrolled' ? o.record.cropPath : null}
                      size={44}
                    />
                    <View style={styles.rowText}>
                      <Text style={styles.file} numberOfLines={1}>
                        {r.fileName}
                      </Text>
                      <Text style={styles.sub} numberOfLines={3}>
                        {sub}
                      </Text>
                    </View>
                    <View style={styles.rowEnd}>
                      <Pill
                        text={ok ? S.import_tag_enrolled : S.import_tag_skipped}
                        color={
                          !ok
                            ? colors.danger
                            : dups.length
                              ? colors.nomatch
                              : colors.match
                        }
                      />
                      <Text style={styles.ms}>
                        {report ? S.ms_value(ms(totalMs(report))) : ''}
                      </Text>
                    </View>
                  </Pressable>
                  {report && open.has(r.key) ? (
                    <View style={styles.status}>
                      <StatusCard
                        report={report}
                        title={S.enroll_status_title}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16 },
  summary: { fontSize: 22, color: colors.onSurface },
  rules: {
    fontSize: 14,
    color: colors.onSurfaceVariant,
    marginTop: 8,
    lineHeight: 20,
  },
  gap: { marginTop: 16 },
  progress: { height: 6, borderRadius: 3 },
  progressText: { fontSize: 13, color: colors.onSurfaceVariant, marginTop: 6 },
  done: {
    fontSize: 16,
    color: colors.onSurface,
    marginTop: 16,
    fontWeight: '600',
  },
  results: { padding: 12 },
  resultsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  resultsTitle: { fontSize: 16, fontWeight: '600', color: colors.onSurface },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 12,
  },
  rowText: { flex: 1 },
  file: { fontSize: 15, color: colors.onSurface },
  sub: { fontSize: 12, color: colors.onSurfaceVariant, marginTop: 2 },
  rowEnd: { alignItems: 'flex-end', gap: 4 },
  ms: { fontSize: 12, color: colors.onSurfaceVariant },
  status: { marginBottom: 8 },
});
