import { StyleSheet, Text, View } from 'react-native';
import { totalMs, type CallReport } from '../data/report';
import { ms, timeText } from '../format';
import { S } from '../strings';
import { colors } from '../theme';
import { AppDialog, Card, Pill, ScoreBar } from './components';

/** Readable names for CallStep.name. */
export function stepName(name: string): string {
  switch (name) {
    case 'faceDetection':
      return S.step_detection;
    case 'templateExtraction':
      return S.step_template;
    case 'similarity':
      return S.step_search;
    case 'livenessCheck':
      return S.step_liveness;
    case 'duplicateCheck':
      return S.step_duplicate;
    case 'save':
      return S.step_save;
    default:
      return name;
  }
}

export function functionName(fn: string): string {
  switch (fn) {
    case 'identify':
      return S.tab_identify;
    case 'enroll':
      return S.action_enroll;
    case 'attribute':
      return S.tab_attribute;
    default:
      return fn ? fn[0]!.toUpperCase() + fn.slice(1) : fn;
  }
}

/**
 * One status UI for every action (identify, enroll, import, attribute): outcome pill, total time,
 * when it finished, then one row per SDK call with pass/fail, its time and its share of the total.
 */
export default function StatusCard({
  report,
  title,
  showDetail = true,
}: {
  report: CallReport;
  title?: string;
  showDetail?: boolean;
}) {
  const total = totalMs(report);
  const ok = report.steps.filter((s) => s.ok).length;
  const at = report.finishedAt > 0 ? timeText(new Date(report.finishedAt)) : '';
  const summary = [
    S.status_total(ms(total)),
    S.status_calls(ok, report.steps.length),
    at,
  ]
    .filter((x) => x)
    .join('  ·  ');
  const share = total > 0 ? total : 1;
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>
          {title ?? S.status_of(functionName(report.function))}
        </Text>
        <Pill
          text={report.success ? S.status_success : S.status_failed}
          color={report.success ? colors.match : colors.danger}
        />
      </View>
      <Text style={styles.summary}>{summary}</Text>
      {report.steps.length === 0 ? (
        <Text style={styles.empty}>{S.status_no_calls}</Text>
      ) : null}
      {report.steps.map((s, i) => {
        const pct = Math.min(1, Math.max(s.ms > 0 ? 0.01 : 0, s.ms / share));
        return (
          <View key={`${s.name}-${i}`} style={styles.step}>
            <View style={styles.stepLine}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: s.ok ? colors.match : colors.danger },
                ]}
              >
                <Text style={styles.dotText}>{s.ok ? '✓' : '✕'}</Text>
              </View>
              <Text style={styles.stepName}>{stepName(s.name)}</Text>
              <Text style={styles.stepMs}>{S.ms_value(ms(s.ms))}</Text>
            </View>
            {s.detail ? (
              <Text style={styles.stepDetail}>{s.detail}</Text>
            ) : null}
            <ScoreBar
              value={pct}
              color={s.ok ? colors.primary : colors.danger}
              style={styles.stepBar}
            />
          </View>
        );
      })}
      {showDetail && (report.detail || report.progress) ? (
        <View style={styles.detailBox}>
          <Text selectable style={styles.detailText}>
            {[report.progress, report.detail].filter((x) => x).join('\n')}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

/** A dialog for an action that stopped (or finished): [reason] on top, then the status card. */
export function StatusDialog({
  visible,
  title,
  reason,
  report,
  onDone,
}: {
  visible: boolean;
  title: string;
  reason?: string | null;
  report?: CallReport | null;
  onDone: () => void;
}) {
  return (
    <AppDialog
      visible={visible}
      title={title}
      message={reason}
      onDismiss={onDone}
      actions={[{ label: S.done, onPress: onDone }]}
    >
      {report ? <StatusCard report={report} /> : null}
    </AppDialog>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.onSurface,
    flexShrink: 1,
  },
  summary: {
    fontSize: 13,
    color: colors.onSurfaceVariant,
    marginTop: 6,
    marginBottom: 4,
  },
  empty: { fontSize: 14, color: colors.onSurface, marginTop: 8 },
  step: { marginTop: 10 },
  stepLine: { flexDirection: 'row', alignItems: 'center' },
  dot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  dotText: { color: colors.white, fontSize: 11, fontWeight: '700' },
  stepName: { flex: 1, fontSize: 14, color: colors.onSurface },
  stepMs: {
    fontSize: 14,
    color: colors.onSurface,
    fontVariant: ['tabular-nums'],
  },
  stepDetail: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    marginLeft: 30,
    marginTop: 2,
  },
  stepBar: { marginLeft: 30, marginTop: 6, height: 3 },
  detailBox: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: colors.surfaceContainer,
  },
  detailText: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    fontFamily: 'monospace',
  },
});
