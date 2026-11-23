import {
  NativeModules,
  NativeEventEmitter,
  Platform,
  type EmitterSubscription,
} from 'react-native';
import { normalizeFaceBox, normalizeFaceBoxes } from './normalizeFaceBox';
import { planLiveFrame, LIVE_FRAME_MAX_EDGE } from './liveFramePrep';
import {
  parseVideoWorkerEvent,
  type VideoWorkerEvent,
} from './capture/videoWorker';
import {
  resultDetailRows,
  livenessPassed,
  qualityText,
  type DetailRow,
  type ResultDisplaySettings,
} from './resultDetails';

const LINKING_ERROR =
  `The package 'face-recognition-sdk' doesn't seem to be linked. Make sure: \n\n` +
  Platform.select({ ios: "- You have run 'pod install'\n", default: '' }) +
  '- You rebuilt the app after installing the package\n' +
  '- You are not using Expo Go\n';

const FaceRecognitionSdk = NativeModules.FaceRecognitionSdk
  ? NativeModules.FaceRecognitionSdk
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      }
    );

const emitter = new NativeEventEmitter(FaceRecognitionSdk);

export type ImageInput = string;

/** VisionCamera takeSnapshot()-like object, or any { path, orientation? }. */
export type LiveCameraPhoto = {
  path: string;
  orientation?: string;
  width?: number;
  height?: number;
};

export type LiveFrameInput = ImageInput | LiveCameraPhoto;

export type LiveFrameOptions = {
  /** Front camera → package applies sensor mount correction. Default true. */
  frontCamera?: boolean;
  /** VisionCamera orientation tag (optional; size after probe drives rotation). */
  orientation?: string;
  /** Advanced: skip policy and rotate by this many degrees. */
  rotateDegrees?: number;
  /** Long-edge cap (default 640). */
  maxEdge?: number;
};

export type FaceBox = {
  /** Opaque native detection handle; pass the returned face unchanged to extraction. */
  detectionId?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  yaw?: number;
  roll?: number;
  pitch?: number;
  liveness?: number;
  face_quality?: number;
  face_luminance?: number;
  left_eye_closed?: number;
  right_eye_closed?: number;
  face_occlusion?: number;
  /** Mouth openness 0..1 (LX engine). null / absent when not computed (e.g. iOS). */
  mouth_opened?: number | null;
  age?: number;
  gender?: number;
  livenessLabel?: string;
  genderLabel?: string;
  emotionLabel?: string;
  maskLabel?: string;
  qualityLabel?: string;
  eyesLeftLabel?: string;
  eyesRightLabel?: string;
  glassesLabel?: string;
  sunglassesLabel?: string;
  occlusionLabel?: string;
  /** Full engine attribute map (PascalCase keys) for Attribute Result UI. */
  attributes?: Record<string, string>;
  landmarkCount?: number;
  landmarks?: number[];
  /** Detection confidence (LX engine). null when the engine does not report it. */
  score?: number | null;
  /** Raw face quality 0..1. null when not computed. */
  quality?: number | null;
  /** Eyes-open score 0..1. null when not computed. */
  eyes_open?: number | null;
  /** Smile score 0..1. null when not computed (iOS framework has no smile score). */
  smile?: number | null;
  /** True when yaw / roll / pitch were computed. */
  poseComputed?: boolean;
};

/** Options for {@link detectFaces}. Every flag defaults to false. */
export type DetectOptions = {
  liveness?: boolean;
  quality?: boolean;
  pose?: boolean;
  ageGender?: boolean;
  eyes?: boolean;
  expression?: boolean;
  points?: boolean;
  /** Extract a template for the first N faces (after sorting). Default 0. */
  templates?: number;
  /** Largest face first. Default false. */
  sortBySize?: boolean;
  /** Decode cap for the long side, in px. Default 1280 (same as the engine). */
  maxSide?: number;
};

/** One detected face from {@link detectFaces}; `template` is base64 when requested. */
export type DetectedFace = FaceBox & {
  template?: string | null;
  templateBytes?: number;
  templateMs?: number;
};

export type DetectResult = {
  width: number;
  height: number;
  detectMs: number;
  templateMs: number;
  faces: DetectedFace[];
};

export type PreparedImage = { uri: string; width: number; height: number };

/** Options for {@link writeFaceImage}. */
export type WriteImageOptions = {
  /** Face box in the decoded image's pixels (from detectFaces with the same maxSide). */
  box?: Pick<FaceBox, 'x1' | 'y1' | 'x2' | 'y2'>;
  /** full = whole image; padded = box + padding; square = square around the box. */
  mode?: 'full' | 'padded' | 'square';
  /** Padding as a fraction of the shorter box side (padded). Default 0.12. */
  padding?: number;
  /** Square side as a multiple of the longer box side (square). Default 1.8. */
  scale?: number;
  /** JPEG quality 1..100. Default 92. */
  quality?: number;
  maxSide?: number;
};

export type EngineInfo = {
  engine: string;
  sdkVersion: string;
  matchThreshold: number;
  livenessThreshold: number;
  filesDir: string;
  supportsSmile: boolean;
  supportsMouthOpen: boolean;
};

export type FaceDetectionParam = {
  allAttributes?: boolean;
  check_liveness?: boolean;
  check_liveness_level?: number;
  check_eye_closeness?: boolean;
  check_face_occlusion?: boolean;
  estimate_age_gender?: boolean;
  check_pose?: boolean;
  check_landmarks?: boolean;
  check_quality?: boolean;
  check_emotion?: boolean;
  check_mask?: boolean;
  check_glasses?: boolean;
};

function constant<T>(name: string, fallback: T): T {
  try {
    const mod = NativeModules.FaceRecognitionSdk;
    const all = mod?.getConstants ? mod.getConstants() : mod;
    const v = all?.[name];
    return v === undefined || v === null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

/** Engine facts from the native side (thresholds, storage root, which values it computes). */
export function engineInfo(): EngineInfo {
  return {
    engine: constant('ENGINE', Platform.OS as string),
    sdkVersion: constant('SDK_VERSION', 'Face Recognition SDK'),
    matchThreshold: constant('MATCH_THRESHOLD', 0.8),
    livenessThreshold: constant('LIVENESS_THRESHOLD', 0.5),
    filesDir: constant('FILES_DIR', ''),
    supportsSmile: constant('SUPPORTS_SMILE', false),
    supportsMouthOpen: constant('SUPPORTS_MOUTH_OPEN', false),
  };
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Detect faces with explicit options on one decoded image and, optionally, extract a
 * template per face on that same image (one native call, timed).
 */
/**
 * Detect on the frame `ingestLiveCameraFrame` / `prepareLiveCameraFrame` already prepared and
 * cached natively. Use this in a preview loop: it saves writing that frame out as a JPEG and
 * decoding it again, which is a whole encode, write and decode per frame.
 */
export async function detectLastLiveFrame(
  options: DetectOptions = {}
): Promise<DetectResult> {
  const json: string = await FaceRecognitionSdk.detectLastLiveFrame(
    JSON.stringify(options)
  );
  let raw: any = {};
  try {
    raw = JSON.parse(json) ?? {};
  } catch {
    raw = {};
  }
  const list: any[] = Array.isArray(raw.faces) ? raw.faces : [];
  return {
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    detectMs: Number(raw.detectMs) || 0,
    templateMs: 0,
    faces: list.map((f) => normalizeFaceBox(f) as DetectedFace),
  };
}

export async function detectFaces(
  image: ImageInput,
  options: DetectOptions = {}
): Promise<DetectResult> {
  const json: string = await FaceRecognitionSdk.detectFaces(
    image,
    JSON.stringify(options)
  );
  let raw: any = {};
  try {
    raw = JSON.parse(json) ?? {};
  } catch {
    raw = {};
  }
  const list: any[] = Array.isArray(raw.faces) ? raw.faces : [];
  const faces: DetectedFace[] = list.map((f) => {
    const box = normalizeFaceBox(f) as DetectedFace;
    return {
      ...box,
      score: finite(f?.score),
      quality: finite(f?.quality),
      eyes_open: finite(f?.eyes_open),
      smile: finite(f?.smile),
      mouth_opened: finite(f?.mouth_opened),
    };
  });
  return {
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    detectMs: Number(raw.detectMs) || 0,
    templateMs: Number(raw.templateMs) || 0,
    faces,
  };
}

/** Decode once (upright, long side <= maxSide) into a cache JPEG; later calls see the same pixels. */
export async function prepareImage(
  image: ImageInput,
  maxSide: number = 1280
): Promise<PreparedImage> {
  const r = await FaceRecognitionSdk.prepareImage(image, maxSide);
  return {
    uri: String(r?.uri ?? ''),
    width: Number(r?.width) || 0,
    height: Number(r?.height) || 0,
  };
}

/** 1:N similarity in one native call. Missing / bad candidates score -1. */
export async function similarityMany(
  probeB64: string,
  candidatesB64: string[]
): Promise<number[]> {
  if (candidatesB64.length === 0) return [];
  const out = await FaceRecognitionSdk.similarityMany(probeB64, candidatesB64);
  return Array.isArray(out) ? out.map((v: unknown) => Number(v)) : [];
}

/** Write the image (or a face crop of it) as JPEG to app storage; resolves its file:// URI. */
export function writeFaceImage(
  image: ImageInput,
  path: string,
  options: WriteImageOptions = {}
): Promise<string> {
  return FaceRecognitionSdk.writeFaceImage(
    image,
    path,
    JSON.stringify(options)
  );
}

/** Delete files (absolute, file:// or relative to the app files dir). Resolves how many went. */
export function deleteFiles(paths: string[]): Promise<number> {
  return FaceRecognitionSdk.deleteFiles(paths);
}

/** Delete every file inside a directory (the directory is kept). Resolves how many went. */
export function deleteDirectory(path: string): Promise<number> {
  return FaceRecognitionSdk.deleteDirectory(path);
}

export type VideoWorkerConfig = {
  matchThreshold?: number;
};

/** FPMC1.… machine code for license requests. */
export function getMachineCode(): Promise<string> {
  return FaceRecognitionSdk.getMachineCode();
}

/** License tier JSON: licensed, level, recognition, liveness, label. */
export function getLicenseStatus(): Promise<string> {
  return FaceRecognitionSdk.getLicenseStatus();
}

/** Activate with FP1.… bound to applicationId / bundle id. Returns SDK status code. */
export function setActivation(license: string): Promise<number> {
  return FaceRecognitionSdk.setActivation(license);
}

/** Load engine + models (off JS thread). Returns SDK status code (0 = success). */
export function init(): Promise<number> {
  return FaceRecognitionSdk.init();
}

export function deinit(): Promise<void> {
  return FaceRecognitionSdk.deinit();
}

export function lastLicenseError(): Promise<string> {
  return FaceRecognitionSdk.lastLicenseError();
}

export function setLandmarkMode(mode: number): Promise<number> {
  return FaceRecognitionSdk.setLandmarkMode(mode);
}

export function getLandmarkMode(): Promise<number> {
  return FaceRecognitionSdk.getLandmarkMode();
}

/** Detect faces + attributes. Returns engine JSON string. */
export function detect(
  image: ImageInput,
  crop: boolean = false,
  flags: number = DETECT_ALL
): Promise<string> {
  return FaceRecognitionSdk.detect(image, crop, flags);
}

/**
 * Structured face boxes (canonical iOS schema).
 * Android bridge output is normalized so `attributes` + label fields match iOS.
 */
export async function faceDetection(
  image: ImageInput,
  param?: FaceDetectionParam | null
): Promise<FaceBox[]> {
  const json = await FaceRecognitionSdk.faceDetection(
    image,
    param ? JSON.stringify(param) : null
  );
  try {
    const parsed = JSON.parse(json);
    return normalizeFaceBoxes(Array.isArray(parsed) ? parsed : []) as FaceBox[];
  } catch {
    return [];
  }
}

/** Extract from a face returned by detection on this same image, without detecting again.
 * Keep the returned face intact. Its native handle is session-local (last 256 faces);
 * a missing or expired handle rejects instead of selecting another face.
 */
export function templateExtraction(
  image: ImageInput,
  faceBox: FaceBox | string
): Promise<string> {
  const boxJson =
    typeof faceBox === 'string' ? faceBox : JSON.stringify(faceBox);
  return FaceRecognitionSdk.templateExtraction(image, boxJson);
}

/** Cropped face JPEG as base64 (NO_WRAP). */
export function cropFace(
  image: ImageInput,
  faceBox: FaceBox | string
): Promise<string> {
  const boxJson =
    typeof faceBox === 'string' ? faceBox : JSON.stringify(faceBox);
  return FaceRecognitionSdk.cropFace(image, boxJson);
}

export function extractFeature(image: ImageInput): Promise<string> {
  return FaceRecognitionSdk.extractFeature(image);
}

export function similarity(
  feature1B64: string,
  feature2B64: string
): Promise<number> {
  return FaceRecognitionSdk.similarity(feature1B64, feature2B64);
}

export function quality(
  image: ImageInput,
  crop: boolean = false
): Promise<string> {
  return FaceRecognitionSdk.quality(image, crop);
}

export function startVideoWorker(
  config: VideoWorkerConfig | string = { matchThreshold: 0.67 }
): Promise<number> {
  const json =
    typeof config === 'string' ? config : JSON.stringify(config ?? {});
  return FaceRecognitionSdk.startVideoWorker(json);
}

export function stopVideoWorker(): Promise<void> {
  return FaceRecognitionSdk.stopVideoWorker();
}

export function syncVideoWorkerDatabase(
  featuresB64: string[],
  matchThreshold: number = 0.67
): Promise<number> {
  return FaceRecognitionSdk.syncVideoWorkerDatabase(
    featuresB64,
    matchThreshold
  );
}

export type LiveFrameResult = {
  ingested: boolean;
  width: number;
  height: number;
  uri?: string | null;
};

function normalizeLiveFrameResult(raw: any): LiveFrameResult {
  return {
    ingested: Boolean(raw?.ingested),
    width: Number(raw?.width) || 0,
    height: Number(raw?.height) || 0,
    uri: typeof raw?.uri === 'string' ? raw.uri : null,
  };
}

function resolveLiveUri(input: LiveFrameInput): string {
  if (typeof input === 'string') {
    if (
      input.startsWith('file://') ||
      input.startsWith('content:') ||
      input.startsWith('data:')
    ) {
      return input;
    }
    if (input.startsWith('/')) {
      return `file://${input}`;
    }
    return input;
  }
  const path = input?.path;
  if (!path || typeof path !== 'string') {
    throw new Error('ingestLiveCameraFrame: expected a URI string or { path }');
  }
  return path.startsWith('file://') || path.startsWith('content:')
    ? path
    : `file://${path}`;
}

function resolveLiveArgs(
  input: LiveFrameInput | boolean,
  frontOrOptions?: boolean | string | LiveFrameOptions,
  orientationArg?: string
): { uri: string; options: LiveFrameOptions } {
  // Legacy: ingestLiveCameraFrame(uri, frontCamera, orientation)
  if (
    typeof input === 'string' ||
    (input && typeof input === 'object' && 'path' in input)
  ) {
    if (typeof frontOrOptions === 'boolean') {
      return {
        uri: resolveLiveUri(input as LiveFrameInput),
        options: {
          frontCamera: frontOrOptions,
          orientation:
            typeof orientationArg === 'string'
              ? orientationArg
              : typeof input === 'object'
                ? input.orientation
                : undefined,
        },
      };
    }
    const opts =
      frontOrOptions && typeof frontOrOptions === 'object'
        ? (frontOrOptions as LiveFrameOptions)
        : {};
    const photoOrient =
      typeof input === 'object' && input && 'orientation' in input
        ? (input as LiveCameraPhoto).orientation
        : undefined;
    return {
      uri: resolveLiveUri(input as LiveFrameInput),
      options: {
        frontCamera: opts.frontCamera !== false,
        orientation: opts.orientation ?? photoOrient,
        rotateDegrees: opts.rotateDegrees,
        maxEdge: opts.maxEdge,
      },
    };
  }
  throw new Error('ingestLiveCameraFrame: invalid arguments');
}

async function prepareAndMaybeFeed(
  input: LiveFrameInput,
  frontOrOptions?: boolean | LiveFrameOptions,
  orientationArg?: string,
  feedWorker: boolean = true
): Promise<LiveFrameResult> {
  const { uri, options } = resolveLiveArgs(
    input,
    frontOrOptions,
    orientationArg
  );
  const maxEdge =
    options.maxEdge != null && options.maxEdge > 0
      ? options.maxEdge
      : LIVE_FRAME_MAX_EDGE;

  let rotateDegrees: number;
  if (options.rotateDegrees != null && Number.isFinite(options.rotateDegrees)) {
    rotateDegrees = options.rotateDegrees;
  } else {
    const probed = await FaceRecognitionSdk.probeLiveImage(uri);
    const plan = planLiveFrame({
      frontCamera: options.frontCamera !== false,
      orientation: options.orientation,
      width: Number(probed?.width) || 0,
      height: Number(probed?.height) || 0,
      maxEdge,
      platform: Platform.OS,
    });
    rotateDegrees = plan.rotateDegrees;
  }

  const raw = await FaceRecognitionSdk.applyLiveFrame(
    uri,
    rotateDegrees,
    maxEdge,
    feedWorker,
    // iOS front snapshots are mirrored on Y. The back camera is upright after +90,
    // and flipping it again mirrors the engine image on Y.
    Platform.OS === 'ios' && options.frontCamera !== false
  );
  return normalizeLiveFrameResult(raw);
}

/**
 * Feed one VisionCamera snapshot (or URI) into VideoWorker.
 *
 * Beginner:
 *   await ingestLiveCameraFrame(photo, { frontCamera: true });
 *
 * Also OK:
 *   await ingestLiveCameraFrame(uri, { frontCamera: true, orientation: 'portrait' });
 *
 * Legacy:
 *   await ingestLiveCameraFrame(uri, true, 'portrait');
 *
 * Geometry (EXIF bake, landscape ±90°) is handled inside the package.
 */
export function ingestLiveCameraFrame(
  input: LiveFrameInput,
  frontOrOptions?: boolean | LiveFrameOptions,
  orientation?: string
): Promise<LiveFrameResult> {
  return prepareAndMaybeFeed(input, frontOrOptions, orientation, true);
}

/**
 * Same prep as ingest, but only writes a JPEG (does not feed VideoWorker).
 * Returns file URI of the prepared frame.
 */
export async function prepareLiveCameraFrame(
  input: LiveFrameInput,
  frontOrOptions?: boolean | LiveFrameOptions,
  orientation?: string
): Promise<string> {
  const result = await prepareAndMaybeFeed(
    input,
    frontOrOptions,
    orientation,
    false
  );
  if (!result.uri) {
    throw new Error('prepareLiveCameraFrame: no output URI');
  }
  return result.uri;
}

/**
 * Prep + feed VideoWorker; returns 0 on accept, 1 if the frame was dropped.
 * Prefer `ingestLiveCameraFrame` for new code.
 */
export async function addVideoWorkerFrame(
  input: LiveFrameInput,
  frontOrOptions?: boolean | LiveFrameOptions,
  orientation?: string
): Promise<number> {
  const result = await prepareAndMaybeFeed(
    input,
    frontOrOptions,
    orientation,
    true
  );
  return result.ingested ? 0 : 1;
}

/** JPEG URI of the last ingested live frame (same bitmap space as VideoWorker). */
export function exportLastLiveFrame(): Promise<LiveFrameResult> {
  return FaceRecognitionSdk.exportLastLiveFrame().then(
    normalizeLiveFrameResult
  );
}

export function writeStatus(payload: Record<string, unknown>): Promise<void> {
  return FaceRecognitionSdk.writeStatus(JSON.stringify(payload));
}

/** Which attribute estimators loaded at init (JSON string). */
export function estimatorStatus(): Promise<string> {
  return FaceRecognitionSdk.estimatorStatus();
}

/** Device smoke: detect + extract Documents/smoke_face.jpg → facerecognition_smoke.json */
export function runDocumentsSmoke(): Promise<string> {
  return FaceRecognitionSdk.runDocumentsSmoke();
}

export type FolderImage = { uri: string; fileName: string };

/** Direct children of a user-picked folder (same rule as the native apps). */
export function pickFolderImages(): Promise<FolderImage[]> {
  return FaceRecognitionSdk.pickFolderImages();
}

/** Subscribe to VideoWorker tracking / match JSON events. */
export function addVideoWorkerListener(
  listener: (json: string) => void
): EmitterSubscription {
  return emitter.addListener('FaceRecognitionVideoWorkerEvent', (event) => {
    listener(typeof event?.json === 'string' ? event.json : '{}');
  });
}

/** Parsed VideoWorker events. Prefer this over raw JSON + parseVideoWorkerEvent. */
export function subscribeVideoWorker(
  cb: (ev: VideoWorkerEvent) => void
): () => void {
  const sub = addVideoWorkerListener((json) => {
    const ev = parseVideoWorkerEvent(json);
    if (ev) cb(ev);
  });
  return () => sub.remove();
}

export const SDK_SUCCESS = 0;
export const SDK_LICENSE_INVALID = 1;
export const SDK_LICENSE_EXPIRED = 2;
export const SDK_NOT_ACTIVATED = 3;
export const SDK_INIT_FAILED = 4;

export const DETECT_POSE = 1 << 0;
export const DETECT_LANDMARKS = 1 << 1;
export const DETECT_AGE = 1 << 2;
export const DETECT_GENDER = 1 << 3;
export const DETECT_EMOTION = 1 << 4;
export const DETECT_MASK = 1 << 5;
export const DETECT_QUALITY = 1 << 6;
export const DETECT_FACE_QUALITY = 1 << 7;
export const DETECT_EYES = 1 << 8;
export const DETECT_LIVENESS = 1 << 9;
export const DETECT_GLASSES = 1 << 11;
export const DETECT_LIVENESS_ACCURATE = 1 << 16;
export const DETECT_ALL = 0xffffffff;

export const LANDMARK_MODE_14 = 14;
export const LANDMARK_MODE_68 = 68;
export const LANDMARK_MODE_468 = 468;

export { normalizeFaceBox, normalizeFaceBoxes };
export { planLiveFrame, LIVE_FRAME_MAX_EDGE };
export { FaceRecognitionSdk };
export { resultDetailRows, livenessPassed, qualityText };
export type { DetailRow, ResultDisplaySettings, VideoWorkerEvent };
export {
  parseLicenseStatus,
  readyStatusMessage,
  NOT_LICENSED,
  type LicenseStatus,
} from './licenseStatus';
