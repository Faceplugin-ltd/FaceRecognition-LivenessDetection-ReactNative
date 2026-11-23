import { useEffect, useState } from 'react';
import * as Gallery from '../data/gallery';
import type { FaceRecord } from '../data/gallery';

/**
 * Current gallery records for [ids] (thumbnails, originals, current names), refreshed on every
 * gallery change. A missing key means "not loaded yet"; null means the person was deleted.
 */
export function useRecords(ids: number[]): Map<number, FaceRecord | null> {
  const [map, setMap] = useState<Map<number, FaceRecord | null>>(new Map());
  const key = [...new Set(ids)].sort((a, b) => a - b).join(',');
  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split(',').map(Number) : [];
    const load = async () => {
      const entries = await Promise.all(
        list.map(async (id) => [id, await Gallery.get(id)] as const)
      );
      if (!cancelled) setMap(new Map(entries));
    };
    load();
    const unsub = Gallery.subscribe(load);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [key]);
  return map;
}

/** Not loaded yet counts as present; deleted ones are dropped from the screen. */
export function exists(
  map: Map<number, FaceRecord | null>,
  id: number
): boolean {
  return !map.has(id) || map.get(id) != null;
}
