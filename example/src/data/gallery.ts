import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deleteDirectory,
  deleteFiles,
  detectFaces,
  similarityMany,
  writeFaceImage,
  type DetectedFace,
} from 'face-recognition-sdk';
import { isReady, serial, stateMessage } from '../engine';
import { idTag, isoNow, score } from '../format';
import {
  makeReport,
  reportToJson,
  step,
  timed,
  type CallReport,
  type CallStep,
} from './report';
import { getSettings, isLive } from './settings';
import { S } from '../strings';

/**
 * On-device gallery (Android shell/data/Gallery.kt + GalleryDb.kt).
 *
 * Storage: React Native has no SQLite in this app's dependencies, so records live in
 * AsyncStorage (one key per person + an id list + a never-reused id counter) and the
 * photos are JPEG files in app-private storage (`gallery/<id>_crop.jpg`, `<id>_original.jpg`).
 * Every engine call goes through the engine queue ([serial]).
 */

export type FaceRecord = {
  id: number;
  name: string;
  note: string;
  /** ISO-8601 UTC */
  createdAt: string;
  /** Template bytes, base64. */
  feature: string;
  cropPath: string;
  originalPath: string;
  /** CallReport JSON; '' for rows enrolled before status tracking. */
  enrollReport: string;
};

/** One gallery hit for a probe face. */
export type Candidate = {
  id: number;
  name: string;
  note: string;
  similarity: number;
};

export type Box = { x1: number; y1: number; x2: number; y2: number };

export type ProbeFace = {
  index: number;
  box: Box;
  /** Top 100 by similarity, highest first. */
  ranked: Candidate[];
};

export type IdentifyResult = {
  probeUri: string;
  width: number;
  height: number;
  faces: ProbeFace[];
  threshold: number;
  extractMs: number;
  searchMs: number;
  gallerySize: number;
  report: CallReport;
};

export type IdentifyOutcome =
  | { kind: 'done'; result: IdentifyResult }
  | { kind: 'rejected'; reason: string; report: CallReport | null };

export type EnrollOutcome =
  | {
      kind: 'enrolled';
      record: FaceRecord;
      report: CallReport;
      /**
       * Every already-enrolled person scoring at or above the identify threshold, highest
       * first — not just the closest. One new face can match several existing ones, and
       * hiding the rest makes the gallery look cleaner than it is.
       */
      duplicates: Candidate[];
      /** The strongest match, for callers that only show one. */
      duplicate: Candidate | null;
    }
  | { kind: 'rejected'; reason: string; report: CallReport | null };

export type FaceAttributes = {
  index: number;
  box: DetectedFace;
  templateBytes: number;
  closest: Candidate | null;
};

export type AttributeResult = {
  probeUri: string;
  width: number;
  height: number;
  report: CallReport;
  /** Every detected face, largest first. Empty when detection found nobody. */
  faces: FaceAttributes[];
  threshold: number;
  gallerySize: number;
};

/** The name a face gets when none was typed: it matches the ID shown beside it. */
export function autoName(id: number): string {
  return `Person ${id}`;
}

export const TOP_K = 100;
export const MAX_ATTRIBUTE_FACES = 10;
export const NO_FACE = 'No face found. Use a clear, front-facing photo.';
const READ_FAIL = 'Could not read this face. Use a clear, front-facing photo.';

const K_IDS = 'gallery_v1_ids';
const K_NEXT = 'gallery_v1_next_id';
const recKey = (id: number) => `gallery_v1_rec_${id}`;
const IMAGES_DIR = 'gallery';

// ---------------------------------------------------------------- store

let records: Map<number, FaceRecord> | null = null;
let nextId = 1;
let loading: Promise<void> | null = null;
let templateCache: FaceRecord[] | null = null;
const listeners = new Set<() => void>();
let writes: Promise<unknown> = Promise.resolve();

function toRow(r: FaceRecord) {
  return {
    id: r.id,
    name: r.name,
    note: r.note,
    created_at: r.createdAt,
    feature: r.feature,
    crop_path: r.cropPath,
    original_path: r.originalPath,
    enroll_report: r.enrollReport,
  };
}

function fromRow(o: any): FaceRecord | null {
  if (!o || typeof o.id !== 'number') return null;
  return {
    id: o.id,
    name: String(o.name ?? ''),
    note: String(o.note ?? ''),
    createdAt: String(o.created_at ?? ''),
    feature: String(o.feature ?? ''),
    cropPath: String(o.crop_path ?? ''),
    originalPath: String(o.original_path ?? ''),
    enrollReport: String(o.enroll_report ?? ''),
  };
}

async function ensureLoaded(): Promise<Map<number, FaceRecord>> {
  if (records) return records;
  if (!loading) {
    loading = (async () => {
      const map = new Map<number, FaceRecord>();
      try {
        const [idsRaw, nextRaw] = await Promise.all([
          AsyncStorage.getItem(K_IDS),
          AsyncStorage.getItem(K_NEXT),
        ]);
        const ids: number[] = idsRaw ? JSON.parse(idsRaw) : [];
        const pairs = ids.length
          ? await AsyncStorage.multiGet(ids.map(recKey))
          : [];
        for (const [, v] of pairs) {
          const r = v ? fromRow(JSON.parse(v)) : null;
          if (r) map.set(r.id, r);
        }
        const maxId = ids.reduce((m, id) => Math.max(m, id), 0);
        nextId = Math.max(Number(nextRaw) || 1, maxId + 1);
      } catch {
        // start empty
      }
      records = map;
    })();
  }
  await loading;
  return records!;
}

function writeChain(job: () => Promise<void>): Promise<void> {
  const run = writes.then(job, job);
  writes = run.catch(() => undefined);
  return run;
}

async function persistIds(map: Map<number, FaceRecord>) {
  await AsyncStorage.setItem(K_IDS, JSON.stringify([...map.keys()]));
}

function changed() {
  templateCache = null;
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Newest first (ids are increasing and never reused). */
async function sorted(): Promise<FaceRecord[]> {
  const map = await ensureLoaded();
  return [...map.values()].sort((a, b) => b.id - a.id);
}

function matches(r: FaceRecord, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    r.name.toLowerCase().includes(needle) ||
    r.note.toLowerCase().includes(needle)
  );
}

async function templates(): Promise<FaceRecord[]> {
  if (!templateCache) {
    templateCache = (await sorted()).filter((r) => r.feature.length > 0);
  }
  return templateCache;
}

// ---------------------------------------------------------------- read

export async function count(query: string = ''): Promise<number> {
  const q = query.trim();
  return (await sorted()).filter((r) => matches(r, q)).length;
}

export async function page(
  query: string,
  limit: number,
  offset: number
): Promise<FaceRecord[]> {
  const q = query.trim();
  return (await sorted())
    .filter((r) => matches(r, q))
    .slice(offset, offset + limit);
}

export async function get(id: number): Promise<FaceRecord | null> {
  return (await ensureLoaded()).get(id) ?? null;
}

// ---------------------------------------------------------------- edit / delete

export async function update(
  id: number,
  name: string,
  note: string
): Promise<boolean> {
  let ok = false;
  await writeChain(async () => {
    const map = await ensureLoaded();
    const r = map.get(id);
    if (!r) return;
    const next = { ...r, name: name.trim(), note: note.trim() };
    map.set(id, next);
    await AsyncStorage.setItem(recKey(id), JSON.stringify(toRow(next)));
    ok = true;
  });
  if (ok) changed();
  return ok;
}

export async function remove(id: number): Promise<boolean> {
  const held: { rec: FaceRecord | null } = { rec: null };
  await writeChain(async () => {
    const map = await ensureLoaded();
    held.rec = map.get(id) ?? null;
    if (!held.rec) return;
    map.delete(id);
    await AsyncStorage.removeItem(recKey(id));
    await persistIds(map);
  });
  const r = held.rec;
  if (!r) return false;
  try {
    await deleteFiles([r.cropPath, r.originalPath].filter((p) => p.length > 0));
  } catch {
    // files are best effort
  }
  changed();
  return true;
}

/** Removes every record and every stored crop / original. Returns how many faces went. */
export async function removeAll(): Promise<number> {
  let n = 0;
  await writeChain(async () => {
    const map = await ensureLoaded();
    n = map.size;
    const keys = [...map.keys()].map(recKey);
    map.clear();
    if (keys.length) await AsyncStorage.multiRemove(keys);
    // A freshly cleared gallery starts at ID 1 again, as it does on Android and iOS — it
    // should not look like it still remembers the last one.
    nextId = 1;
    await AsyncStorage.setItem(K_NEXT, String(nextId));
    await persistIds(map);
  });
  try {
    await deleteDirectory(IMAGES_DIR);
  } catch {
    // best effort
  }
  changed();
  return n;
}

// ---------------------------------------------------------------- engine flows

function facesDetail(n: number): string {
  return n === 1 ? '1 face' : `${n} faces`;
}

function boxOf(f: Box): Box {
  return { x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2 };
}

/** Similarity of [feature] against the whole gallery, highest first. */
async function rank(
  feature: string,
  gallery: FaceRecord[]
): Promise<Candidate[]> {
  if (gallery.length === 0) return [];
  const scores = await serial(() =>
    similarityMany(
      feature,
      gallery.map((g) => g.feature)
    )
  );
  return gallery
    .map((g, i) => ({
      id: g.id,
      name: g.name,
      note: g.note,
      similarity: scores[i] ?? -1,
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Exactly-one-face enrollment. [photoUri] should be upright with long side ≤ 1280
 * (prepareImage / a prepared camera frame). Steps: detection, template, duplicate check, save.
 */
export async function enroll(
  name: string,
  note: string,
  photoUri: string
): Promise<EnrollOutcome> {
  const cleanName = name.trim();
  // A blank name is allowed: the face is named after the ID it is about to be given, so the
  // People list and the identify headline never show an empty space where a name belongs.
  if (!isReady())
    return { kind: 'rejected', reason: stateMessage(), report: null };
  const steps: CallStep[] = [];

  let detected;
  try {
    detected = await serial(() =>
      detectFaces(photoUri, { pose: true, eyes: true, templates: 1 })
    );
  } catch {
    return { kind: 'rejected', reason: S.photo_unreadable, report: null };
  }
  const faces = detected.faces;
  steps.push(
    step(
      'faceDetection',
      detected.detectMs,
      facesDetail(faces.length),
      faces.length === 1
    )
  );
  if (faces.length === 0) {
    return {
      kind: 'rejected',
      reason: NO_FACE,
      report: makeReport('enroll', steps, 'No face', '', false),
    };
  }
  if (faces.length > 1) {
    return {
      kind: 'rejected',
      reason: `${faces.length} faces found. Use a photo that shows only one person.`,
      report: makeReport('enroll', steps, `${faces.length} faces`, '', false),
    };
  }
  const face = faces[0]!;
  const feature = face.template ?? '';
  steps.push(
    step(
      'templateExtraction',
      face.templateMs ?? detected.templateMs,
      feature ? `${face.templateBytes ?? 0} bytes` : 'no template',
      feature.length > 0
    )
  );
  if (!feature) {
    return {
      kind: 'rejected',
      reason: READ_FAIL,
      report: makeReport('enroll', steps, 'template failed', '', false),
    };
  }

  const threshold = getSettings().threshold;
  const gallery = await templates();
  const [ranked, dupStep] = await timed(
    'duplicateCheck',
    async () => rank(feature, gallery),
    (list: Candidate[]) => {
      if (list.length === 0) return 'gallery empty';
      const over = list.filter((c) => c.similarity >= threshold);
      if (over.length === 0) {
        const c = list[0]!;
        return `closest ${c.name} · ${idTag(c.id)} · ${score(c.similarity)}`;
      }
      return (
        over
          .map((c) => `${c.name} · ${idTag(c.id)} · ${score(c.similarity)}`)
          .join(', ') +
        ' · possible duplicate' +
        (over.length > 1 ? 's' : '')
      );
    }
  );
  steps.push(dupStep);

  const held: { record: FaceRecord | null } = { record: null };
  const t0 = Date.now();
  try {
    await writeChain(async () => {
      const map = await ensureLoaded();
      const id = nextId++;
      await AsyncStorage.setItem(K_NEXT, String(nextId));
      const box = boxOf(face);
      const cropPath = await serial(() =>
        writeFaceImage(photoUri, `${IMAGES_DIR}/${id}_crop.jpg`, {
          box,
          mode: 'padded',
          padding: 0.12,
        })
      );
      const originalPath = await serial(() =>
        writeFaceImage(photoUri, `${IMAGES_DIR}/${id}_original.jpg`, {
          mode: 'full',
          quality: 90,
        })
      );
      const record: FaceRecord = {
        id,
        name: cleanName || autoName(id),
        note: note.trim(),
        createdAt: isoNow(),
        feature,
        cropPath,
        originalPath,
        enrollReport: '',
      };
      held.record = record;
      map.set(id, record);
      await AsyncStorage.setItem(recKey(id), JSON.stringify(toRow(record)));
      await persistIds(map);
    });
  } catch (e: any) {
    steps.push(
      step('save', Date.now() - t0, String(e?.message ?? 'save failed'), false)
    );
    return {
      kind: 'rejected',
      reason: S.enroll_failed,
      report: makeReport('enroll', steps, 'save failed', '', false),
    };
  }
  const saved = held.record;
  if (!saved) {
    return {
      kind: 'rejected',
      reason: S.enroll_failed,
      report: makeReport('enroll', steps, 'save failed', '', false),
    };
  }
  steps.push(
    step(
      'save',
      Date.now() - t0,
      `${idTag(saved.id)} · ${gallery.length + 1} enrolled`
    )
  );

  const duplicates = ranked.filter((c) => c.similarity >= threshold);
  const duplicate = duplicates[0] ?? null;
  const report = makeReport(
    'enroll',
    steps,
    duplicates.length === 0
      ? `Saved ${saved.name} as ${idTag(saved.id)}`
      : `Saved ${saved.name} as ${idTag(saved.id)} · looks like ` +
        duplicates.map((c) => `${c.name} (${idTag(c.id)})`).join(', '),
    `${steps.length} of ${steps.length} · saved`
  );
  const withReport: FaceRecord = {
    ...saved,
    enrollReport: reportToJson(report),
  };
  await writeChain(async () => {
    const map = await ensureLoaded();
    if (!map.has(saved.id)) return;
    map.set(saved.id, withReport);
    await AsyncStorage.setItem(
      recKey(saved.id),
      JSON.stringify(toRow(withReport))
    );
  });
  changed();
  return { kind: 'enrolled', record: withReport, report, duplicates, duplicate };
}

/**
 * 1:N identify: detect (with liveness when on) → liveness check (every face must be live)
 * → template for every face → similarity against the whole gallery, top 100 per face.
 */
export async function identify(
  probeUri: string,
  threshold: number,
  liveness: boolean
): Promise<IdentifyOutcome> {
  if (!isReady())
    return { kind: 'rejected', reason: stateMessage(), report: null };
  const steps: CallStep[] = [];
  let detected;
  try {
    detected = await serial(() =>
      detectFaces(probeUri, { liveness, pose: true, eyes: true, templates: 20 })
    );
  } catch {
    return { kind: 'rejected', reason: S.photo_unreadable, report: null };
  }
  const faces = detected.faces;
  steps.push(
    step(
      'faceDetection',
      detected.detectMs,
      facesDetail(faces.length),
      faces.length > 0
    )
  );
  if (faces.length === 0) {
    return {
      kind: 'rejected',
      reason: NO_FACE,
      report: makeReport('identify', steps, 'No face', '', false),
    };
  }
  if (liveness) {
    const s = getSettings();
    const live = faces.filter((f) => isLive(s, f.liveness)).length;
    const lowest = Math.min(...faces.map((f) => f.liveness ?? 0));
    // Liveness is scored during detection; this step applies the threshold.
    steps.push(
      step(
        'livenessCheck',
        0,
        `${live} of ${faces.length} live · lowest ${score(lowest)} / ${score(s.livenessThreshold)}`,
        live === faces.length
      )
    );
    if (live < faces.length) {
      return {
        kind: 'rejected',
        reason: `${S.liveness_check_failed_body}\n${S.liveness_turn_off_hint}`,
        report: makeReport('identify', steps, 'Liveness failed', '', false),
      };
    }
  }
  const extracted = faces.filter((f) => !!f.template);
  steps.push(
    step(
      'templateExtraction',
      detected.templateMs,
      `${extracted.length} templates`,
      extracted.length > 0
    )
  );
  if (extracted.length === 0) {
    return {
      kind: 'rejected',
      reason: READ_FAIL,
      report: makeReport('identify', steps, 'template failed', '', false),
    };
  }

  const gallery = await templates();
  const [probeFaces, searchStep] = await timed(
    'similarity',
    async () => {
      const out: ProbeFace[] = [];
      for (let i = 0; i < extracted.length; i++) {
        const f = extracted[i]!;
        const ranked = (await rank(f.template!, gallery)).slice(0, TOP_K);
        out.push({ index: i, box: boxOf(f), ranked });
      }
      return out;
    },
    () => `${gallery.length} enrolled · ${extracted.length} probes`
  );
  steps.push(searchStep);
  const bests = probeFaces
    .map((p) => p.ranked[0]?.similarity)
    .filter((v): v is number => v != null);
  const best = bests.length ? Math.max(...bests) : null;
  const report = makeReport(
    'identify',
    steps,
    best == null
      ? 'Gallery empty'
      : `Best similarity ${score(best)} · threshold ${score(threshold)}`,
    `${steps.length} of ${steps.length} · similarity`
  );
  const extractMs = steps
    .filter((s) => s.name !== 'similarity')
    .reduce((a, s) => a + s.ms, 0);
  const searchMs = steps
    .filter((s) => s.name === 'similarity')
    .reduce((a, s) => a + s.ms, 0);
  return {
    kind: 'done',
    result: {
      probeUri,
      width: detected.width,
      height: detected.height,
      faces: probeFaces,
      threshold,
      extractMs,
      searchMs,
      gallerySize: gallery.length,
      report,
    },
  };
}

/**
 * Attribute detection on every face (largest first), then a template and a best gallery hit
 * per face for up to [MAX_ATTRIBUTE_FACES] faces. Never rejects.
 */
export async function attributes(probeUri: string): Promise<AttributeResult> {
  const steps: CallStep[] = [];
  const threshold = getSettings().threshold;
  const empty = (detail: string): AttributeResult => ({
    probeUri,
    width: 0,
    height: 0,
    report: makeReport('attribute', steps, detail, '', false),
    faces: [],
    threshold,
    gallerySize: 0,
  });
  if (!isReady()) return empty(stateMessage());
  const gallery = await templates();
  let detected;
  try {
    detected = await serial(() =>
      detectFaces(probeUri, {
        liveness: true,
        quality: true,
        pose: true,
        ageGender: true,
        eyes: true,
        expression: true,
        points: true,
        templates: MAX_ATTRIBUTE_FACES,
        sortBySize: true,
      })
    );
  } catch {
    return empty(S.photo_unreadable);
  }
  const faces = detected.faces;
  steps.push(
    step(
      'faceDetection',
      detected.detectMs,
      `${facesDetail(faces.length)} · attributes`,
      faces.length > 0
    )
  );
  const searched = faces.slice(0, MAX_ATTRIBUTE_FACES);
  const withTemplate = searched.filter((f) => !!f.template).length;
  if (faces.length > 0) {
    steps.push(
      step(
        'templateExtraction',
        detected.templateMs,
        `${withTemplate} of ${searched.length} templates`,
        withTemplate > 0
      )
    );
  }
  let closest: (Candidate | null)[] = [];
  if (withTemplate > 0) {
    const [hits, simStep] = await timed(
      'similarity',
      async () => {
        const out: (Candidate | null)[] = [];
        for (const f of searched) {
          out.push(
            f.template && gallery.length
              ? ((await rank(f.template, gallery))[0] ?? null)
              : null
          );
        }
        return out;
      },
      () => `${gallery.length} enrolled · ${withTemplate} probes`
    );
    steps.push(simStep);
    closest = hits;
  }
  const list: FaceAttributes[] = faces.map((b, i) => ({
    index: i,
    box: b,
    templateBytes:
      i < searched.length && b.template ? (b.templateBytes ?? 0) : 0,
    closest: closest[i] ?? null,
  }));
  const hit = list
    .map((f) => f.closest)
    .filter((c): c is Candidate => c != null)
    .sort((a, b) => b.similarity - a.similarity)[0];
  const detail =
    list.length === 0
      ? 'No face'
      : facesDetail(list.length) +
        (hit ? ` · closest ${hit.name} ${score(hit.similarity)}` : '');
  return {
    probeUri,
    width: detected.width,
    height: detected.height,
    report: makeReport('attribute', steps, detail, '', list.length > 0),
    faces: list,
    threshold,
    gallerySize: gallery.length,
  };
}
