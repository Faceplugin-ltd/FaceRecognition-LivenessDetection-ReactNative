import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import {
  addVideoWorkerListener,
  cropFace,
  exportLastLiveFrame,
  faceDetection,
  ingestLiveCameraFrame,
  startVideoWorker,
  stopVideoWorker,
  type FaceBox,
} from '../index';
import {
  checkFace,
  mergeEyes,
  warningFor,
  type CaptureState,
} from './captureLogic';
import CaptureOverlay, { type CaptureViewMode } from './CaptureOverlay';
import { parseVideoWorkerEvent, workerFaceToBox } from './videoWorker';
import type { CaptureResult, CaptureSettings } from './types';

const UI = {
  text: '#E6E1E5',
  accentDim: '#4F378B',
  blackBg: '#303033',
  danger: '#FF6B6B',
  accent: '#D0BCFF',
};

function qualityText(score: number): string {
  if (score < 0.5) return `Low · ${Math.round(score * 100)}%`;
  if (score < 0.75) return `Medium · ${Math.round(score * 100)}%`;
  return `High · ${Math.round(score * 100)}%`;
}

export type FaceCaptureProps = {
  settings: CaptureSettings;
  onCaptured: (result: CaptureResult) => void;
  onCancel?: () => void;
  /** Optional actions under the result metrics (e.g. Enroll). */
  renderActions?: (result: CaptureResult) => ReactNode;
  title?: string;
  /** Hide the liveness / quality lines under the captured still (host shows its own review). */
  hideResultDetails?: boolean;
};

/**
 * Ready-made Capture mode UI (oval guide + VideoWorker + eye/pose gates).
 * Requires peers: react-native-vision-camera, react-native-svg.
 * Does not enroll people or use React Navigation — wire those in the host app.
 */
export function FaceCapture({
  settings,
  onCaptured,
  onCancel,
  renderActions,
  title = 'Face Capture',
  hideResultDetails = false,
}: FaceCaptureProps) {
  const { width, height } = useWindowDimensions();
  const device = useCameraDevice(settings.camera_lens);
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const busyRef = useRef(false);
  const lastUriRef = useRef<string | null>(null);
  const lastEyesRef = useRef<FaceBox[]>([]);
  const okStreakRef = useRef(0);
  const viewModeRef = useRef<CaptureViewMode>('NO_FACE_PREPARE');
  const [viewMode, setViewMode] = useState<CaptureViewMode>('NO_FACE_PREPARE');
  const [warning, setWarning] = useState('');
  const [faceBox, setFaceBox] = useState<FaceBox | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 720, h: 1280 });
  const frameSizeRef = useRef({ w: 720, h: 1280 });
  const [captureUri, setCaptureUri] = useState<string | null>(null);
  const [capturedFace, setCapturedFace] = useState<FaceBox | null>(null);
  const [resultBox, setResultBox] = useState<FaceBox | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [captureResult, setCaptureResult] = useState<CaptureResult | null>(
    null
  );
  const [holdProgress, setHoldProgress] = useState(0);
  const cancelHoldRef = useRef<() => void>(() => {});
  const settingsRef = useRef(settings);
  const capturedFaceRef = useRef<FaceBox | null>(null);
  const onCapturedRef = useRef(onCaptured);

  settingsRef.current = settings;
  onCapturedRef.current = onCaptured;

  const setMode = useCallback((mode: CaptureViewMode) => {
    if (viewModeRef.current === mode) return;
    if (mode !== 'FACE_CIRCLE') cancelHoldRef.current();
    viewModeRef.current = mode;
    setViewMode(mode);
  }, []);

  useEffect(() => {
    capturedFaceRef.current = capturedFace;
  }, [capturedFace]);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const finishWithResult = useCallback(
    async (shown: FaceBox | null, bitmapUri: string | null) => {
      if (!shown || !bitmapUri) {
        setShowResult(true);
        return;
      }
      setResultBox(shown);
      setCapturedFace(shown);
      capturedFaceRef.current = shown;
      const still = checkFace(
        [shown],
        settingsRef.current,
        frameSizeRef.current
      );
      if (still === 'FACE_OCCLUDED') setWarning('Face occluded!');
      else if (still === 'EYE_CLOSED') setWarning('Eye closed!');

      let cropB64: string | null = null;
      try {
        cropB64 = await cropFace(bitmapUri, shown);
      } catch {
        cropB64 = null;
      }
      const result: CaptureResult = {
        uri: bitmapUri,
        faceBox: shown,
        cropB64,
      };
      setCaptureResult(result);
      setShowResult(true);
      onCapturedRef.current(result);
    },
    []
  );

  const onModeFinished = useCallback(
    async (mode: CaptureViewMode) => {
      if (mode === 'NO_FACE_PREPARE') {
        setMode('REPEAT_NO_FACE_PREPARE');
      } else if (mode === 'TO_FACE_CIRCLE') {
        setMode('FACE_CIRCLE');
      } else if (mode === 'FACE_CIRCLE_TO_NO_FACE') {
        setMode('NO_FACE_PREPARE');
      } else if (mode === 'FACE_CAPTURE_PREPARE') {
        setMode('FACE_CAPTURE_DONE');
      } else if (mode === 'FACE_CAPTURE_DONE') {
        const uri = lastUriRef.current;
        const fallback = capturedFaceRef.current;
        const s = settingsRef.current;
        if (!uri) {
          setShowResult(true);
          return;
        }
        try {
          // The worker keeps running while the still is detected; stopping it here tore the
          // preview down for the length of the call and left the screen frozen.
          const boxes = await faceDetection(uri, {
            allAttributes: true,
            check_liveness_level: s.liveness_level,
          });
          await finishWithResult(boxes[0] ?? fallback, uri);
        } catch {
          await finishWithResult(fallback, uri);
        }
      }
    },
    [finishWithResult, setMode]
  );

  useEffect(() => {
    if (!hasPermission || !device) return;
    let cancelled = false;
    const workerReady = { current: false };

    const HOLD_MS = 2000;
    let holdGen = 0;
    let holding = false;
    let holdUri: string | null = null;
    let holdFace: FaceBox | null = null;
    let holdFrame = 0;
    let holdSeq = 0;

    const cancelHold = () => {
      holdGen += 1;
      holding = false;
      holdUri = null;
      holdFace = null;
      if (holdFrame) cancelAnimationFrame(holdFrame);
      holdFrame = 0;
      setHoldProgress(0);
    };
    cancelHoldRef.current = cancelHold;

    const rememberHold = async () => {
      const gen = holdGen;
      const seq = ++holdSeq;
      try {
        const exported = await exportLastLiveFrame();
        if (gen !== holdGen || seq !== holdSeq || !exported.uri) return;
        if (viewModeRef.current !== 'FACE_CIRCLE') return;
        holdUri = exported.uri;
        if (exported.width > 0 && exported.height > 0) {
          frameSizeRef.current = { w: exported.width, h: exported.height };
          setFrameSize(frameSizeRef.current);
        }
      } catch {
        // keep the previous hold frame
      }
    };

    const finishHold = async () => {
      const gen = holdGen;
      if (cancelled || viewModeRef.current !== 'FACE_CIRCLE') return;
      await rememberHold();
      if (
        cancelled ||
        gen !== holdGen ||
        viewModeRef.current !== 'FACE_CIRCLE'
      ) {
        return;
      }
      const uri = holdUri;
      const face = holdFace;
      if (!uri || !face) {
        cancelHold();
        return;
      }
      lastUriRef.current = uri;
      setCaptureUri(uri);
      setCapturedFace(face);
      capturedFaceRef.current = face;
      setWarning('');
      okStreakRef.current = 0;
      setMode('FACE_CAPTURE_PREPARE');
    };

    const startHold = () => {
      if (holding) return;
      holding = true;
      const started = Date.now();
      const gen = holdGen;
      const step = () => {
        if (gen !== holdGen || cancelled) return;
        const t = Math.min(1, (Date.now() - started) / HOLD_MS);
        setHoldProgress(t);
        if (t >= 1) {
          holding = false;
          holdFrame = 0;
          void finishHold();
          return;
        }
        holdFrame = requestAnimationFrame(step);
      };
      holdFrame = requestAnimationFrame(step);
    };

    const sub = addVideoWorkerListener((json) => {
      if (cancelled) return;
      const mode = viewModeRef.current;
      if (mode === 'FACE_CAPTURE_DONE' || mode === 'NO_FACE_PREPARE') return;
      const ev = parseVideoWorkerEvent(json);
      if (ev?.type !== 'tracking') return;
      const s = settingsRef.current;
      let boxes = ev.faces.filter((f) => !f.weak).map(workerFaceToBox);
      boxes = mergeEyes(boxes, lastEyesRef.current, s.camera_lens === 'front');
      const frame = frameSizeRef.current;
      const state: CaptureState = checkFace(boxes, s, frame);
      setFaceBox(boxes[0] ?? null);

      if (mode === 'REPEAT_NO_FACE_PREPARE') {
        if (state !== 'NO_FACE') {
          setMode('TO_FACE_CIRCLE');
        }
        return;
      }

      if (mode === 'FACE_CIRCLE') {
        if (state === 'NO_FACE') {
          setWarning('');
          okStreakRef.current = 0;
          cancelHold();
          setMode('FACE_CIRCLE_TO_NO_FACE');
          return;
        }
        if (state === 'CAPTURE_OK' && boxes[0]) {
          // Eye labels are optional: the liveness pack has no attribute models.
          holdFace = boxes[0];
          setWarning('');
          void rememberHold();
          startHold();
          return;
        }
        okStreakRef.current = 0;
        cancelHold();
        setWarning(warningFor(state));
        return;
      }
    });

    (async () => {
      try {
        const code = await startVideoWorker({
          matchThreshold: settings.match_threshold,
        });
        if (!cancelled) workerReady.current = code === 0;
      } catch {
        workerReady.current = false;
      }
    })();

    // VisionCamera takeSnapshot = silent preview grab (not takePhoto shutter).
    // Chain after each ingest so ticks never overlap (no setInterval pile-up).
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    (async () => {
      while (!cancelled) {
        const mode = viewModeRef.current;
        if (
          !workerReady.current ||
          mode === 'NO_FACE_PREPARE' ||
          mode === 'FACE_CAPTURE_DONE' ||
          busyRef.current ||
          !cameraRef.current
        ) {
          await sleep(80);
          continue;
        }
        busyRef.current = true;
        try {
          const photo = await cameraRef.current.takeSnapshot({ quality: 85 });
          const front = settingsRef.current.camera_lens !== 'back';
          const live = await ingestLiveCameraFrame(photo, {
            frontCamera: front,
          });
          if (live.ingested && live.width > 0 && live.height > 0) {
            frameSizeRef.current = { w: live.width, h: live.height };
            setFrameSize(frameSizeRef.current);
          }
          // Do not call check_eye_closeness on every frame: this SDK pack
          // lacks eyes_openness v2 and spam-logs pb_run.
          if (live.ingested) {
            try {
              const exported = await exportLastLiveFrame();
              if (exported.uri) lastUriRef.current = exported.uri;
            } catch {
              // export optional
            }
          }
        } catch {
          // Camera warming up
        } finally {
          busyRef.current = false;
        }
        await sleep(100);
      }
    })();

    return () => {
      cancelled = true;
      cancelHold();
      workerReady.current = false;
      sub.remove();
      stopVideoWorker();
    };
  }, [hasPermission, device, setMode]);

  if (!hasPermission || !device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={UI.accent} />
      </View>
    );
  }

  const front = settings.camera_lens === 'front';
  // iOS front preview is mirrored; Android preview matches unmirrored snapshot.
  const mirrorOverlay = front && Platform.OS === 'ios';
  const shown = resultBox;
  // The Settings liveness threshold decides, not the SDK's fixed-0.5 Live/Fake label.
  const livenessLine = (() => {
    if (!shown) return '';
    const v = (shown.liveness ?? 0).toFixed(2);
    return (shown.liveness ?? 0) + 0.0001 >= settings.liveness_threshold
      ? `Liveness: Real, score = ${v}`
      : `Liveness: Spoof, score = ${v}`;
  })();

  return (
    <View style={styles.root}>
      {viewMode !== 'FACE_CAPTURE_DONE' ? (
        <>
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={device}
            isActive
            photo
            video
            audio={false}
            isMirrored={false}
            resizeMode="cover"
            pointerEvents="none"
          />
          <CaptureOverlay
            width={width}
            height={height}
            frame={frameSize}
            mirror={mirrorOverlay}
            viewMode={viewMode}
            holdProgress={holdProgress}
            faceBox={faceBox}
            capturedUri={null}
            onModeFinished={onModeFinished}
          />
        </>
      ) : (
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: UI.blackBg }]}
        >
          <CaptureOverlay
            width={width}
            height={height}
            frame={frameSize}
            mirror={mirrorOverlay}
            viewMode={viewMode}
            holdProgress={holdProgress}
            faceBox={faceBox}
            capturedUri={captureUri}
            onModeFinished={onModeFinished}
          />
        </View>
      )}

      <Text style={styles.title}>{title}</Text>
      {warning ? <Text style={styles.warnTop}>{warning}</Text> : null}

      {showResult ? (
        <View style={styles.resultPane} pointerEvents="box-none">
          <View style={styles.resultSpacer} />
          {hideResultDetails ? null : (
            <>
              <Text style={styles.resultLine}>{livenessLine}</Text>
              <Text style={styles.resultLine}>
                {qualityText(shown?.face_quality ?? 0)}
                {shown?.qualityLabel ? `\n${shown.qualityLabel}` : ''}
              </Text>
            </>
          )}
          {captureResult && renderActions ? renderActions(captureResult) : null}
        </View>
      ) : null}

      {onCancel ? (
        <View style={styles.chrome} pointerEvents="box-none" collapsable={false}>
          <TouchableOpacity
            style={styles.back}
            onPress={onCancel}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={styles.backText}>←</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI.blackBg,
  },
  title: {
    position: 'absolute',
    top: 16,
    width: '100%',
    textAlign: 'center',
    color: UI.text,
    fontSize: 22,
    fontWeight: '600',
    height: 48,
    lineHeight: 48,
  },
  warnTop: {
    position: 'absolute',
    top: 64,
    right: 20,
    color: UI.danger,
    fontSize: 16,
    zIndex: 5,
  },
  resultPane: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  resultSpacer: {
    width: '100%',
    aspectRatio: 1,
  },
  resultLine: {
    color: UI.text,
    fontSize: 18,
    marginTop: 16,
    marginLeft: 24,
  },
  chrome: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    elevation: 20,
  },
  back: {
    position: 'absolute',
    top: 52,
    left: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: UI.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { color: UI.text, fontSize: 22 },
});

export default FaceCapture;
