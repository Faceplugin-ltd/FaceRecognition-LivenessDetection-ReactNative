import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  Text,
  ToastAndroid,
} from 'react-native';

type Listener = (msg: string) => void;
let listener: Listener | null = null;

/** Short message (Android Toast / Snackbar). Uses the platform toast on Android. */
export function showToast(msg: string) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(
      msg,
      msg.length > 60 ? ToastAndroid.LONG : ToastAndroid.SHORT
    );
    return;
  }
  listener?.(msg);
}

/** Renders iOS toasts; mount once near the root. */
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    listener = (m) => {
      setMsg(m);
      if (timer.current) clearTimeout(timer.current);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
      timer.current = setTimeout(
        () => {
          Animated.timing(opacity, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
          }).start(() => setMsg(null));
        },
        m.length > 60 ? 3500 : 2000
      );
    };
    return () => {
      listener = null;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [opacity]);

  if (!msg) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.toast, { opacity }]}>
      <Text style={styles.text}>{msg}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 96,
    backgroundColor: '#313033',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  text: { color: '#F4EFF4', fontSize: 14 },
});
