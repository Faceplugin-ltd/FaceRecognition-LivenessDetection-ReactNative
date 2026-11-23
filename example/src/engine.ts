import { useEffect, useState } from 'react';
import {
  engineInfo,
  getLicenseStatus,
  getMachineCode,
  init,
  parseLicenseStatus,
  setActivation,
  NOT_LICENSED,
  SDK_INIT_FAILED,
  SDK_LICENSE_EXPIRED,
  SDK_LICENSE_INVALID,
  SDK_NOT_ACTIVATED,
  SDK_SUCCESS,
  type LicenseStatus,
} from 'face-recognition-sdk';
import { demoLicense } from './license';

/**
 * Process-wide engine owner (Android shell/engine/Engine.kt): activation with the built-in key
 * plus init in the background, one queue that serializes every SDK call, and a state observable.
 */
export type EngineState =
  | 'LOADING'
  | 'READY'
  | 'NOT_ACTIVATED'
  | 'LICENSE_INVALID'
  | 'LICENSE_EXPIRED'
  | 'FAILED'
  | 'SDK_MISSING';

let state: EngineState = 'LOADING';
let started = false;
const listeners = new Set<(s: EngineState) => void>();

function publish(s: EngineState) {
  state = s;
  listeners.forEach((l) => l(s));
}

export function engineState(): EngineState {
  return state;
}

export function isReady(): boolean {
  return state === 'READY';
}

export function stateMessage(s: EngineState = state): string {
  switch (s) {
    case 'LOADING':
      return 'Loading engine';
    case 'READY':
      return 'Ready';
    case 'NOT_ACTIVATED':
      return 'Not activated';
    case 'LICENSE_INVALID':
      return 'License key is invalid';
    case 'LICENSE_EXPIRED':
      return 'License expired';
    case 'FAILED':
      return 'Engine failed to start';
    case 'SDK_MISSING':
      return 'Recognition SDK missing';
  }
}

// ---- one queue for every SDK call (camera loop, identify, enroll, import) ----

let tail: Promise<unknown> = Promise.resolve();

/** Runs [job] after every job queued before it. */
export function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.catch(() => undefined);
  return run;
}

let pending = 0;

/** Like [serial], but drops the job (resolves null) when something is already queued. Camera frames. */
export function serialIfIdle<T>(job: () => Promise<T>): Promise<T | null> {
  if (pending > 0) return Promise.resolve(null);
  pending++;
  return serial(job).finally(() => {
    pending--;
  });
}

/** Activate with the key compiled into the app, then init. Runs once. */
export function startEngine(): void {
  if (started) return;
  started = true;
  publish('LOADING');
  serial(async () => {
    let code: number;
    try {
      await getMachineCode();
      code = await setActivation(demoLicense());
      if (code === SDK_SUCCESS) code = await init();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      code = msg.includes("doesn't seem to be linked") ? -100 : SDK_INIT_FAILED;
    }
    switch (code) {
      case SDK_SUCCESS:
        publish('READY');
        break;
      case SDK_NOT_ACTIVATED:
        publish('NOT_ACTIVATED');
        break;
      case SDK_LICENSE_INVALID:
        publish('LICENSE_INVALID');
        break;
      case SDK_LICENSE_EXPIRED:
        publish('LICENSE_EXPIRED');
        break;
      case -100:
        publish('SDK_MISSING');
        break;
      default:
        publish('FAILED');
    }
  });
}

export async function licenseStatus(): Promise<LicenseStatus> {
  try {
    return parseLicenseStatus(await serial(() => getLicenseStatus()));
  } catch {
    return NOT_LICENSED;
  }
}

export function sdkVersion(): string {
  try {
    return engineInfo().sdkVersion;
  } catch {
    return 'Face Recognition SDK';
  }
}

export function useEngineState(): EngineState {
  const [s, setS] = useState<EngineState>(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
