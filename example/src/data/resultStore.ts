import type { AttributeResult, Candidate, IdentifyResult } from './gallery';

/** Hands the last identify / attribute result to the pushed screen (Android ResultStore). */
export const ResultStore: {
  last: IdentifyResult | null;
  attribute: AttributeResult | null;
} = { last: null, attribute: null };

/**
 * Matches at/above the threshold across all probe faces, best score per person, highest first.
 */
export function allMatches(r: IdentifyResult): Candidate[] {
  const best = new Map<number, Candidate>();
  for (const f of r.faces) {
    for (const c of f.ranked) {
      if (c.similarity < r.threshold) continue;
      const prev = best.get(c.id);
      if (!prev || c.similarity > prev.similarity) best.set(c.id, c);
    }
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity);
}

/** The face whose best candidate scores highest (headline and Rank 1 tile). */
export function primaryFace(r: IdentifyResult) {
  let pick = r.faces[0]!;
  let top = -2;
  for (const f of r.faces) {
    const s = f.ranked[0]?.similarity ?? -1;
    if (s > top) {
      top = s;
      pick = f;
    }
  }
  return pick;
}
