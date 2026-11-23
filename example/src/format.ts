/** Number / id / date formatting shared by every screen (Android shell/Ui.kt). */

/** IDs are always shown as a tag "ID 12" — never "#12". */
export function idTag(id: number): string {
  return `ID ${id}`;
}

/** Two decimals: similarity, thresholds, scores. */
export function score(v: number): string {
  return (Number.isFinite(v) ? v : 0).toFixed(2);
}

export function f1(v: number): string {
  return (Number.isFinite(v) ? v : 0).toFixed(1);
}

/** ≥ 100 → no decimals, else 1 decimal. */
export function ms(v: number): string {
  const n = Number.isFinite(v) ? v : 0;
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

export function facesCount(n: number): string {
  return n === 1 ? '1 face' : `${n} faces`;
}

export function matchesCount(n: number): string {
  return n === 1 ? '1 match' : `${n} matches`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** ISO-8601 UTC, seconds precision: 2026-01-03T19:53:10Z */
export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseIso(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Jan 3, 2026" (local date). */
export function dateText(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "7:53:10 PM" (local time, with seconds). */
export function timeText(d: Date, seconds = true): string {
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${mm}${seconds ? `:${ss}` : ''} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export function enrolledDate(iso: string): string {
  const d = parseIso(iso);
  return d ? dateText(d) : iso;
}

export function enrolledDateTime(iso: string): string {
  const d = parseIso(iso);
  return d ? `${dateText(d)}, ${timeText(d, false)}` : iso;
}

/** File name without extension. */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.substring(0, dot) : name;
}
