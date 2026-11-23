/**
 * Call report shown by the status card (Android shell/data/Gallery.kt CallStep / CallReport).
 * Serialized as JSON into the gallery's `enroll_report`.
 */

/** One timed SDK call. `ok` is false when this step stopped the action. */
export type CallStep = {
  name: string;
  ms: number;
  detail: string;
  ok: boolean;
};

export type CallReport = {
  function: string;
  steps: CallStep[];
  progress: string;
  detail: string;
  success: boolean;
  /** Wall-clock time the action finished (epoch ms). */
  finishedAt: number;
};

export function totalMs(r: CallReport): number {
  return r.steps.reduce(
    (sum, s) => sum + (Number.isFinite(s.ms) ? s.ms : 0),
    0
  );
}

export function step(
  name: string,
  ms: number,
  detail: string,
  ok: boolean = true
): CallStep {
  return { name, ms, detail, ok };
}

/** Builds a report; progress defaults to "n of n · last" or "ok of n · stopped at step". */
export function makeReport(
  fn: string,
  steps: CallStep[],
  detail: string,
  progress: string = '',
  success: boolean = true
): CallReport {
  let shown = progress;
  if (!shown) {
    if (success) {
      shown = `${steps.length} of ${steps.length} · ${steps[steps.length - 1]?.name ?? 'done'}`;
    } else {
      const ok = steps.filter((s) => s.ok).length;
      const at = steps.find((s) => !s.ok)?.name ?? 'start';
      shown = `${ok} of ${steps.length} · stopped at ${at}`;
    }
  }
  return {
    function: fn,
    steps: [...steps],
    progress: shown,
    detail,
    success,
    finishedAt: Date.now(),
  };
}

export function reportToJson(r: CallReport): string {
  return JSON.stringify(r);
}

export function reportFromJson(
  raw: string | null | undefined
): CallReport | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    const steps: CallStep[] = (Array.isArray(o.steps) ? o.steps : []).map(
      (s: any) => ({
        name: String(s?.name ?? ''),
        ms: Number(s?.ms) || 0,
        detail: String(s?.detail ?? ''),
        ok: s?.ok !== false,
      })
    );
    return {
      function: String(o.function ?? ''),
      steps,
      progress: String(o.progress ?? ''),
      detail: String(o.detail ?? ''),
      success: o.success !== false,
      finishedAt: Number(o.finishedAt) || 0,
    };
  } catch {
    return null;
  }
}

/** Times an async block; the step's detail / ok come from its value. */
export async function timed<T>(
  name: string,
  block: () => Promise<T>,
  detail: (v: T) => string,
  ok: (v: T) => boolean = () => true
): Promise<[T, CallStep]> {
  const t0 = Date.now();
  const v = await block();
  return [v, step(name, Date.now() - t0, detail(v), ok(v))];
}
