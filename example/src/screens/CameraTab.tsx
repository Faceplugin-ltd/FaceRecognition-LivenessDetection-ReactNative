import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  type PhotoFile,
} from 'react-native-vision-camera';
import { launchImageLibrary } from 'react-native-image-picker';
import {
  deleteFiles,
  detectLastLiveFrame,
  ingestLiveCameraFrame,
  prepareImage,
  prepareLiveCameraFrame,
} from 'face-recognition-sdk';
import * as Gallery from '../data/gallery';
import type { CallReport } from '../data/report';
import { ResultStore } from '../data/resultStore';
import { updateSettings, useSettings, getSettings } from '../data/settings';
import { serialIfIdle, stateMessage, useEngineState } from '../engine';
import { facesCount, score } from '../format';
import type { RootStackParamList } from '../navigation';
import { S } from '../strings';
import { colors } from '../theme';
import { Button, IconButton, Tag } from '../ui/components';
import Icon from '../ui/Icon';
import { StatusDialog } from '../ui/StatusCard';
import { showToast } from '../ui/Toast';

type Status = { text: string; good: boolean };
/** Auto fires once one good face has stayed in place this long — Android AUTO_STABLE_MS. */
const AUTO_STABLE_MS = 300;

const ST = {
  OK: { text: S.status_face_ok, good: true },
  NO_FACE: { text: S.status_no_face, good: false },
  MOVE_CLOSER: { text: S.status_move_closer, good: false },
  TOO_DARK: { text: S.status_too_dark, good: false },
  MANY: { text: S.status_many_faces, good: false },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const photoUri = (p: PhotoFile) =>
  p.path.startsWith('file://') ? p.path : `file://${p.path}`;

/**
 * Live camera screen shared by Identity (1:N identify) and Attribute (Android IdentifyFragment):
 * status chip, threshold chip, gallery count, Gallery · shutter · Auto.
 */
export default function CameraTab({
  mode,
  active,
}: {
  mode: 'identify' | 'attribute';
  active: boolean;
}) {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const settings = useSettings();
  const engine = useEngineState();
  const ready = engine === 'READY';
  const { hasPermission, requestPermission } = useCameraPermission();
  const [lens, setLens] = useState<'front' | 'back'>('front');
  const device = useCameraDevice(lens) ?? undefined;
  const fallbackDevice = useCameraDevice('front');
  const cameraRef = useRef<Camera>(null);
  const previewReady = useRef(false);

  const [status, setStatus] = useState<Status>(ST.NO_FACE);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const [count, setCount] = useState(0);
  const [stopped, setStopped] = useState<{
    reason: string;
    report: CallReport;
  } | null>(null);

  const lastPhoto = useRef<PhotoFile | null>(null);
  const lastStatus = useRef<Status>(ST.NO_FACE);
  const stableSince = useRef(0);
  const lastCenter = useRef<{ x: number; y: number } | null>(null);
  const autoRef = useRef(settings.autoCapture);
  autoRef.current = settings.autoCapture;
  const lensRef = useRef(lens);
  lensRef.current = lens;

  const setBusy = useCallback(
    (on: boolean) => {
      busyRef.current = on;
      setBusyState(on);
      if (on)
        setStatus({
          text:
            mode === 'attribute' ? S.status_attributes : S.status_identifying,
          good: false,
        });
    },
    [mode]
  );

  // gallery count tag
  useEffect(() => {
    const refresh = () => Gallery.count().then(setCount);
    refresh();
    return Gallery.subscribe(refresh);
  }, []);

  // back on this tab (e.g. from Result): not busy any more
  useEffect(() => {
    if (active) {
      setBusy(false);
      stableSince.current = 0;
    }
  }, [active, setBusy]);

  const run = useCallback(
    async (probeUri: string) => {
      if (mode === 'attribute') {
        const result = await Gallery.attributes(probeUri);
        ResultStore.attribute = result;
        navigation.navigate('AttributeResult');
        return;
      }
      const s = getSettings();
      const outcome = await Gallery.identify(probeUri, s.threshold, s.liveness);
      if (outcome.kind === 'done') {
        ResultStore.last = outcome.result;
        navigation.navigate('Result');
      } else if (outcome.report == null) {
        setBusy(false);
        showToast(outcome.reason);
      } else {
        // Stay busy while the status is open so auto-capture does not fire again behind it.
        setStopped({ reason: outcome.reason, report: outcome.report });
      }
    },
    [mode, navigation, setBusy]
  );

  /** Identify / read attributes on the last camera frame (full size, upright). */
  const fire = useCallback(async () => {
    const photo = lastPhoto.current;
    if (busyRef.current) return;
    if (!photo || lastStatus.current === ST.NO_FACE) {
      showToast(Gallery.NO_FACE);
      return;
    }
    setBusy(true);
    try {
      const probe = await prepareLiveCameraFrame(photo, {
        frontCamera: lensRef.current === 'front',
        maxEdge: 1280,
      });
      await run(probe);
    } catch {
      setBusy(false);
      showToast(S.photo_unreadable);
    }
  }, [run, setBusy]);

  const pickGallery = useCallback(async () => {
    if (busyRef.current) return;
    const res = await launchImageLibrary({
      mediaType: 'photo',
      selectionLimit: 1,
    });
    const uri = res.assets?.[0]?.uri;
    if (!uri) return;
    setBusy(true);
    try {
      const prepared = await prepareImage(uri, 1280);
      await run(prepared.uri);
    } catch {
      setBusy(false);
      showToast(S.photo_unreadable);
    }
  }, [run, setBusy]);

  // live analyzer: snapshot → upright small frame → face detection only (no pose / eyes)
  useEffect(() => {
    if (!active || !ready || !hasPermission) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const cam = cameraRef.current;
        // The coach keeps reading frames while a search runs. Pausing the loop until the
        // engine came back froze the boxes and the status on whatever the last frame had
        // said, which is what made the camera look stopped.
        // takeSnapshot before the preview has produced a new frame returns the last
        // session's picture, and on iOS that still stays on screen.
        if (!cam || !previewReady.current) {
          await sleep(120);
          continue;
        }
        let photo: PhotoFile | null = null;
        try {
          photo = await cam.takeSnapshot({ quality: 85 });
          // Prepare the frame natively and detect on the cached bitmap. Going through
          // prepareLiveCameraFrame + detectFaces instead meant a JPEG encode, a file write and
          // a second decode on every preview frame.
          await ingestLiveCameraFrame(photo, {
            frontCamera: lensRef.current === 'front',
          });
          const r = await serialIfIdle(() => detectLastLiveFrame());
          if (cancelled || !r) {
            deleteFiles([photoUri(photo)]).catch(() => {});
            continue;
          }
          const faces = r.faces;
          const f = faces[0];
          let st: Status;
          if (faces.length === 0) st = ST.NO_FACE;
          else if (faces.length > 1) st = ST.MANY;
          else if (f!.x2 - f!.x1 < r.width * 0.28) st = ST.MOVE_CLOSER;
          else if (
            (f!.face_luminance ?? 0) > 0.001 &&
            (f!.face_luminance ?? 0) < 0.25
          )
            st = ST.TOO_DARK;
          else st = ST.OK;

          const previous = lastPhoto.current;
          lastPhoto.current = photo;
          if (previous && !busyRef.current)
            deleteFiles([photoUri(previous)]).catch(() => {});

          const now = Date.now();
          if (st === ST.OK && f) {
            const c = { x: (f.x1 + f.x2) / 2, y: (f.y1 + f.y2) / 2 };
            const prev = lastCenter.current;
            const moved =
              !prev ||
              Math.abs(prev.x - c.x) > r.width * 0.06 ||
              Math.abs(prev.y - c.y) > r.height * 0.06;
            if (moved || stableSince.current === 0) stableSince.current = now;
            lastCenter.current = c;
          } else {
            stableSince.current = 0;
            lastCenter.current = null;
          }
          lastStatus.current = st;
          if (busyRef.current) continue;
          setStatus(st);
          if (
            st === ST.OK &&
            autoRef.current &&
            stableSince.current !== 0 &&
            now - stableSince.current >= AUTO_STABLE_MS
          ) {
            stableSince.current = 0;
            fire();
          }
        } catch {
          // camera warming up / frame dropped
          await sleep(150);
        }
        await sleep(60);
      }
    })();
    return () => {
      cancelled = true;
      previewReady.current = false;
      // Reset with the camera: leaving the last frame's status behind meant re-entering the
      // tab showed the previous visit's reading over a preview that had not started yet.
      stableSince.current = 0;
      lastCenter.current = null;
      lastStatus.current = ST.NO_FACE;
      lastPhoto.current = null;
      setStatus(ST.NO_FACE);
    };
  }, [active, ready, hasPermission, fire]);

  const cameraDevice = device ?? fallbackDevice;
  let message: {
    text: string;
    action?: { label: string; onPress: () => void };
  } | null = null;
  if (!hasPermission) {
    message = {
      text: S.camera_permission_needed,
      action: { label: S.allow_camera, onPress: () => requestPermission() },
    };
  } else if (!ready) {
    message = { text: stateMessage(engine) };
  } else if (!cameraDevice) {
    message = { text: S.unavailable };
  }

  const title = mode === 'attribute' ? S.tab_attribute : S.tab_identify;
  const shutterEnabled = ready && !busy && hasPermission;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Tag text={facesCount(count)} />
      </View>

      <View style={styles.cameraBox}>
        {active && hasPermission && cameraDevice ? (
          <Camera
            key={lens}
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={cameraDevice}
            isActive
            photo
            video
            audio={false}
            isMirrored={false}
            resizeMode="cover"
            onPreviewStarted={() => {
              previewReady.current = true;
            }}
            onPreviewStopped={() => {
              previewReady.current = false;
            }}
          />
        ) : null}

        <View style={styles.topRow} pointerEvents="box-none">
          <View
            style={[
              styles.chip,
              {
                backgroundColor: status.good ? colors.match : colors.cameraChip,
              },
            ]}
          >
            <Text style={styles.chipText}>{status.text}</Text>
          </View>
        </View>
        <IconButton
          name="switchCamera"
          color={colors.white}
          label={S.txt_switch_camera}
          style={styles.switchCam}
          onPress={() => setLens((l) => (l === 'front' ? 'back' : 'front'))}
        />
        <View style={[styles.chip, styles.thresholdChip]}>
          <Text style={styles.chipText}>
            {S.txt_threshold_chip(score(settings.threshold))}
          </Text>
        </View>

        {message ? (
          <View style={styles.message}>
            <Text style={styles.messageText}>{message.text}</Text>
            {message.action ? (
              <Button
                title={message.action.label}
                onPress={message.action.onPress}
                style={styles.messageButton}
              />
            ) : null}
          </View>
        ) : null}
        {busy ? (
          <View style={styles.busy} pointerEvents="none">
            <ActivityIndicator size="large" color={colors.white} />
          </View>
        ) : null}
      </View>

      <View style={styles.bottom}>
        <Pressable style={styles.side} onPress={pickGallery} disabled={busy}>
          <Icon name="gallery" color={colors.onSurface} />
          <Text style={styles.sideText}>{S.gallery}</Text>
        </Pressable>
        <Pressable
          onPress={fire}
          disabled={!shutterEnabled}
          accessibilityLabel={S.capture}
          style={[styles.shutter, !shutterEnabled && styles.shutterOff]}
        >
          <View style={styles.shutterInner} />
        </Pressable>
        <Pressable
          style={styles.side}
          onPress={() => {
            updateSettings({ autoCapture: !settings.autoCapture });
            stableSince.current = 0;
          }}
        >
          <Switch
            value={settings.autoCapture}
            onValueChange={(v) => {
              updateSettings({ autoCapture: v });
              stableSince.current = 0;
            }}
            trackColor={{ true: colors.primary, false: colors.surfaceVariant }}
            thumbColor={colors.white}
          />
          <Text style={styles.sideText}>{S.auto}</Text>
        </Pressable>
      </View>

      <StatusDialog
        visible={stopped != null}
        title={S.identify_stopped}
        reason={stopped?.reason}
        report={stopped?.report}
        onDone={() => {
          setStopped(null);
          stableSince.current = 0;
          setBusy(false);
          setStatus(lastStatus.current);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    height: 56,
  },
  title: { fontSize: 22, color: colors.onSurface },
  cameraBox: { flex: 1, backgroundColor: colors.black, overflow: 'hidden' },
  topRow: {
    position: 'absolute',
    top: 12,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  chip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16 },
  chipText: { color: colors.white, fontSize: 14, fontWeight: '500' },
  thresholdChip: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    backgroundColor: colors.cameraChip,
  },
  switchCam: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: colors.cameraChip,
  },
  message: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.cameraScrim,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  messageText: { color: colors.white, fontSize: 16, textAlign: 'center' },
  messageButton: { marginTop: 16 },
  busy: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 14,
    backgroundColor: colors.surface,
  },
  side: { width: 88, alignItems: 'center', gap: 4 },
  sideText: { fontSize: 12, color: colors.onSurface },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterOff: { opacity: 0.4 },
  shutterInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
  },
});
