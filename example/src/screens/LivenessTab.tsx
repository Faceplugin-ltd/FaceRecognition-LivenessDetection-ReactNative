import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  type PhotoFile,
} from 'react-native-vision-camera';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';
import {
  deleteFiles,
  detectLastLiveFrame,
  ingestLiveCameraFrame,
  type DetectedFace,
} from 'face-recognition-sdk';
import { S } from '../strings';
import { isReady, serialIfIdle, stateMessage, useEngineState } from '../engine';
import { useSettings } from '../data/settings';
import { colors } from '../theme';
import { IconButton } from '../ui/components';

const LIVE = '#2EE6A6';
const FAKE = '#FF6B6B';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const photoUri = (p: PhotoFile) => (p.path.startsWith('file://') ? p.path : `file://${p.path}`);

/**
 * Liveness on its own: the camera, a box per face and that face's liveness score. There is
 * nothing to press — no shutter, no gallery, no result screen. It is the plainest possible
 * demonstration that the engine tells a live face from a photo of one.
 */
export default function LivenessTab({ active }: { active: boolean }) {
  const engine = useEngineState();
  const settings = useSettings();
  const { hasPermission, requestPermission } = useCameraPermission();

  const [lens, setLens] = useState<'front' | 'back'>('front');
  const lensRef = useRef(lens);
  lensRef.current = lens;

  const cameraRef = useRef<Camera>(null);
  const previewReady = useRef(false);
  const device = useCameraDevice(lens);
  const [faces, setFaces] = useState<DetectedFace[]>([]);
  const [frame, setFrame] = useState({ w: 0, h: 0 });

  const ready = isReady();

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    if (!active || !ready || !hasPermission) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const cam = cameraRef.current;
        if (!cam || !previewReady.current) {
          await sleep(120);
          continue;
        }
        let photo: PhotoFile | null = null;
        try {
          photo = await cam.takeSnapshot({ quality: 85 });
          await ingestLiveCameraFrame(photo, {
            frontCamera: lensRef.current === 'front',
          });
          // Liveness is the whole point of this screen, so it is the one estimator asked for.
          const r = await serialIfIdle(() =>
            detectLastLiveFrame({ liveness: true })
          );
          if (!cancelled && r) {
            setFaces(r.faces);
            setFrame({ w: r.width, h: r.height });
          }
        } catch {
          await sleep(150);
        } finally {
          if (photo) deleteFiles([photoUri(photo)]).catch(() => {});
        }
        await sleep(60);
      }
    })();
    return () => {
      cancelled = true;
      previewReady.current = false;
      // The boxes go with the camera, so a revisited tab never shows the last visit's faces.
      setFaces([]);
      setFrame({ w: 0, h: 0 });
    };
  }, [active, ready, hasPermission]);

  const threshold = settings.livenessThreshold;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{S.tab_liveness}</Text>
        <IconButton
          name="switchCamera"
          color={colors.onSurface}
          label={S.txt_switch_camera}
          onPress={() => setLens((l) => (l === 'front' ? 'back' : 'front'))}
        />
      </View>

      <View style={styles.cameraBox}>
        {active && hasPermission && device ? (
          <Camera
            key={lens}
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={device}
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

        {frame.w > 0 && frame.h > 0 ? (
          <Svg
            style={StyleSheet.absoluteFill}
            viewBox={`0 0 ${frame.w} ${frame.h}`}
            preserveAspectRatio="xMidYMid slice"
          >
            {faces.map((f, i) => {
              const live = (f.liveness ?? 0) >= threshold;
              const colour = live ? LIVE : FAKE;
              return (
                <Rect
                  key={`box${i}`}
                  x={f.x1}
                  y={f.y1}
                  width={Math.max(0, f.x2 - f.x1)}
                  height={Math.max(0, f.y2 - f.y1)}
                  rx={9}
                  fill="none"
                  stroke={colour}
                  strokeWidth={3}
                />
              );
            })}
            {faces.map((f, i) => {
              const live = (f.liveness ?? 0) >= threshold;
              return (
                <SvgText
                  key={`label${i}`}
                  x={f.x1 + 4}
                  y={Math.max(16, f.y1 - 8)}
                  fill={live ? LIVE : FAKE}
                  fontSize={18}
                  fontWeight="600"
                >
                  {`${live ? 'Live' : 'Fake'} ${(f.liveness ?? 0).toFixed(2)}`}
                </SvgText>
              );
            })}
          </Svg>
        ) : null}

        {!ready || faces.length === 0 ? (
          <View style={styles.hintWrap} pointerEvents="none">
            <Text style={styles.hint}>
              {ready ? S.status_no_face : stateMessage(engine)}
            </Text>
          </View>
        ) : null}
      </View>
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
  hintWrap: { position: 'absolute', bottom: 24, left: 0, right: 0, alignItems: 'center' },
  hint: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    color: '#fff',
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    overflow: 'hidden',
  },
});
