/**
 * Gyroscope air-mouse: phone rotation rate becomes cursor velocity. expo-sensors is a native module,
 * so it loads dynamically - the web preview (no module) simply hides the toggle.
 * Rate-based control needs no calibration and cannot drift; the dead zone absorbs hand tremor.
 */
import { Platform } from 'react-native';

type Rotation = { x: number; y: number; z: number };
type Subscription = { remove: () => void };
type GyroModule = { isAvailableAsync: () => Promise<boolean>; setUpdateInterval: (ms: number) => void;
  addListener: (listener: (rotation: Rotation) => void) => Subscription; removeAllListeners: () => void };

const UPDATE_MS = 33;         // ~30 events/s: smooth without flooding the socket
const DEAD_ZONE = 0.05;       // rad/s below which the hand is "still"
const SCALE = 220;            // px per rad/s, per update - tuned for a laptop screen at arm's length

let moduleCache: GyroModule | null | undefined;
function gyroModule(): GyroModule | null {
  if (Platform.OS === 'web') return null;
  if (moduleCache === undefined) {
    try { moduleCache = require('expo-sensors').Gyroscope as GyroModule; } catch { moduleCache = null; }
  }
  return moduleCache;
}
/** False on the web preview and on devices without a gyroscope. */
export async function gyroAvailable(): Promise<boolean> {
  const gyro = gyroModule();
  if (!gyro) return false;
  try { return await gyro.isAvailableAsync(); } catch { return false; }
}

/** Starts streaming cursor deltas; returns a stop function. dx from roll (tilt left/right), dy from pitch (tilt forward/back). */
export function startGyroMouse(onMove: (dx: number, dy: number) => void): () => void {
  const gyro = gyroModule();
  if (!gyro) return () => {};
  gyro.setUpdateInterval(UPDATE_MS);
  const sub = gyro.addListener(({ x, y }) => {
    const dx = Math.abs(y) < DEAD_ZONE ? 0 : (y - Math.sign(y) * DEAD_ZONE) * SCALE;
    const dy = Math.abs(x) < DEAD_ZONE ? 0 : (x - Math.sign(x) * DEAD_ZONE) * SCALE;
    if (dx || dy) onMove(dx, dy);
  });
  return () => sub.remove();
}
