import { useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { colors } from '../theme';

/**
 * Material slider (no extra dependency): drag or tap the track. Calls [onChange] live with the
 * value snapped to [step].
 */
export default function Slider({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const startX = useRef(0);
  const cb = useRef(onChange);
  cb.current = onChange;
  const range = useRef({ min, max, step });
  range.current = { min, max, step };

  const fromX = (x: number) => {
    const w = widthRef.current;
    const { min: lo, max: hi, step: st } = range.current;
    if (w <= 0) return lo;
    const t = Math.min(1, Math.max(0, (x - THUMB / 2) / (w - THUMB)));
    const raw = lo + t * (hi - lo);
    const snapped = Math.round((raw - lo) / st) * st + lo;
    const decimals = st < 1 ? Math.ceil(-Math.log10(st)) : 0;
    return Number(Math.min(hi, Math.max(lo, snapped)).toFixed(decimals));
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          startX.current = e.nativeEvent.locationX;
          cb.current(fromX(startX.current));
        },
        onPanResponderMove: (_e, g) => {
          cb.current(fromX(startX.current + g.dx));
        },
      }),

    []
  );

  const onLayout = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
    setWidth(e.nativeEvent.layout.width);
  };

  const t =
    max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0;
  const thumbLeft = t * Math.max(0, width - THUMB);

  return (
    <View style={styles.root} onLayout={onLayout} {...pan.panHandlers}>
      <View pointerEvents="none" style={styles.track}>
        <View style={[styles.active, { width: thumbLeft + THUMB / 2 }]} />
      </View>
      <View pointerEvents="none" style={[styles.thumb, { left: thumbLeft }]} />
    </View>
  );
}

const THUMB = 20;

const styles = StyleSheet.create({
  root: { height: 40, justifyContent: 'center' },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.secondaryContainer,
    marginHorizontal: THUMB / 2,
    overflow: 'hidden',
  },
  active: {
    height: 4,
    backgroundColor: colors.primary,
    marginLeft: -THUMB / 2,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: colors.primary,
    top: 10,
  },
});
