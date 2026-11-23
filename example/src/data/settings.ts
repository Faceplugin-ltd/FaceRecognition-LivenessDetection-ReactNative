import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Persisted demo settings (Android shell/data/AppSettings.kt).
 * Match and liveness defaults are the engine operating points: 0.80 and 0.5.
 */
export type AppSettings = {
  threshold: number;
  liveness: boolean;
  livenessThreshold: number;
  yaw: number;
  roll: number;
  pitch: number;
  /** Eye threshold ("Eye closed" on the Settings page): eyes pass when open score ≥ this. */
  eye: number;
  autoCapture: boolean;
  /** Enroll straight away when every check passes, skipping the capture review. */
  skipReview: boolean;
};

export const MIN_THRESHOLD = 0.7;
export const MAX_THRESHOLD = 0.9;

// The engine operating points, the same ones AppSettings uses on Android: match 0.80,
// liveness off and scored at 0.5, head pose 20 degrees.
export const DEFAULT_SETTINGS: AppSettings = {
  threshold: 0.8,
  liveness: false,
  livenessThreshold: 0.5,
  yaw: 20,
  roll: 20,
  pitch: 20,
  eye: 0.5,
  autoCapture: false,
  skipReview: false,
};

// v4: the defaults moved to the engine operating points, so a stored v3 set is not reused.
const KEY = 'face_identity_settings_v4';

let current: AppSettings = { ...DEFAULT_SETTINGS };
let loaded = false;
const listeners = new Set<(s: AppSettings) => void>();

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function clampThreshold(v: number): number {
  return Math.round(clamp(v, MIN_THRESHOLD, MAX_THRESHOLD, 0.8) * 100) / 100;
}

function sanitize(p: any): AppSettings {
  const d = DEFAULT_SETTINGS;
  return {
    threshold: clampThreshold(p?.threshold ?? d.threshold),
    liveness: typeof p?.liveness === 'boolean' ? p.liveness : d.liveness,
    livenessThreshold: clamp(p?.livenessThreshold, 0, 1, d.livenessThreshold),
    yaw: clamp(p?.yaw, 0, 90, d.yaw),
    roll: clamp(p?.roll, 0, 90, d.roll),
    pitch: clamp(p?.pitch, 0, 90, d.pitch),
    eye: clamp(p?.eye, 0, 1, d.eye),
    autoCapture:
      typeof p?.autoCapture === 'boolean' ? p.autoCapture : d.autoCapture,
    skipReview:
      typeof p?.skipReview === 'boolean' ? p.skipReview : d.skipReview,
  };
}

export async function loadSettings(): Promise<AppSettings> {
  if (loaded) return current;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    current = sanitize(raw ? JSON.parse(raw) : {});
  } catch {
    current = { ...DEFAULT_SETTINGS };
  }
  loaded = true;
  listeners.forEach((l) => l(current));
  return current;
}

/** Last loaded value (defaults before the first load finishes). */
export function getSettings(): AppSettings {
  return current;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  current = sanitize({ ...current, ...patch });
  loaded = true;
  listeners.forEach((l) => l(current));
  AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
  return current;
}

/** Restores every default except Auto (Android AppSettings.reset). */
export function resetSettings(): AppSettings {
  return updateSettings({
    ...DEFAULT_SETTINGS,
    autoCapture: current.autoCapture,
  });
}

/** The one eye rule: the eye threshold from Settings is used as is; pass when open ≥ it. */
export function eyesPass(s: AppSettings, openScore: number): boolean {
  return openScore + 0.0001 >= s.eye;
}

/**
 * The one liveness rule (Identify, Attribute, Add person): live when the score is at or above the
 * liveness threshold in Settings. The SDK's own Live/Fake label (fixed 0.5) is ignored.
 */
export function isLive(
  s: AppSettings,
  scoreValue: number | null | undefined
): boolean {
  return (
    typeof scoreValue === 'number' &&
    Number.isFinite(scoreValue) &&
    scoreValue + 0.0001 >= s.livenessThreshold
  );
}

export function useSettings(): AppSettings {
  const [s, setS] = useState<AppSettings>(current);
  useEffect(() => {
    listeners.add(setS);
    loadSettings().then(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
