/**
 * Single live-frame geometry policy for Android + iOS.
 * JS owns all front/back / landscape branching; native only rotates + scales.
 *
 * `width` / `height` must be after EXIF / UIImage orientation bake (from probeLiveImage).
 * VisionCamera `orientation` is accepted for API completeness / future use; the
 * post-bake aspect ratio is what drives the rotation today.
 */

export const LIVE_FRAME_MAX_EDGE = 640;

export type LiveFramePrepInput = {
  frontCamera: boolean;
  /** VisionCamera takeSnapshot().orientation (e.g. portrait, landscape-left). */
  orientation?: string;
  width: number;
  height: number;
  maxEdge?: number;
  /** Host OS. Portrait snapshots are already upright after EXIF bake on both. */
  platform?: 'ios' | 'android' | string;
};

export type LiveFramePrepPlan = {
  rotateDegrees: number;
  maxEdge: number;
};

/**
 * Decide rotateDegrees + maxEdge for VideoWorker / side-detect frames.
 *
 * 1. Landscape (w > h): −90°. Android back stays +90°. iOS back +90° was 180° off.
 * 2. Else: 0°. Portrait VisionCamera snapshots are already upright; an extra
 *    +180° on iOS front flipped the Identify probe on the Y axis.
 */
export function planLiveFrame(input: LiveFramePrepInput): LiveFramePrepPlan {
  const maxEdge =
    input.maxEdge != null && input.maxEdge > 0
      ? Math.floor(input.maxEdge)
      : LIVE_FRAME_MAX_EDGE;
  const w = Number(input.width) || 0;
  const h = Number(input.height) || 0;

  const platform = (input.platform ?? '').toLowerCase();
  let rotateDegrees = 0;
  if (w > h) {
    rotateDegrees = !input.frontCamera && platform === 'android' ? 90 : -90;
  }

  return { rotateDegrees, maxEdge };
}
