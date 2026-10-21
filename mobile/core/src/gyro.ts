/** Gyroscope air-mouse mapping: phone rotation rate becomes cursor velocity. Pure math, no sensors here. */

export const GYRO_UPDATE_MS = 33;   // ~30 events/s: smooth without flooding the socket
export const GYRO_DEAD_ZONE = 0.05; // rad/s below which the hand is "still" (absorbs tremor)
export const GYRO_SCALE = 220;      // px per rad/s, per update - tuned for a laptop screen at arm's length

export interface RotationRate { x: number; y: number }

/** One axis: 0 inside the dead zone, linear past it with the zone subtracted so motion starts smoothly. */
export function gyroAxis(rate: number, deadZone = GYRO_DEAD_ZONE, scale = GYRO_SCALE): number {
  return !Number.isFinite(rate) || Math.abs(rate) < deadZone ? 0 : (rate - Math.sign(rate) * deadZone) * scale;
}

/** dx from roll (tilt left/right = y), dy from pitch (tilt forward/back = x). Null when the hand is still. */
export function gyroDeltas(rotation: RotationRate, deadZone = GYRO_DEAD_ZONE, scale = GYRO_SCALE): { dx: number; dy: number } | null {
  const dx = gyroAxis(rotation.y, deadZone, scale);
  const dy = gyroAxis(rotation.x, deadZone, scale);
  return dx || dy ? { dx, dy } : null;
}
