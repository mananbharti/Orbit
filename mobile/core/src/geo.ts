/** Geofence math for scene place triggers; depends on nothing. */

export interface PlaceTrigger {
  sceneId: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  on: 'arrive' | 'leave';
}

const EARTH_RADIUS_M = 6_371_000;
/** Extra distance beyond the radius that must be crossed to re-arm a trigger, so GPS jitter at the edge never double-fires. */
const HYSTERESIS_M = 60;

export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Tracks inside/outside per trigger and emits a scene id exactly once per crossing. */
export class GeoTriggerEvaluator {
  private readonly inside = new Map<string, boolean>();

  /** Feeds one fix; returns scene ids whose trigger fired on this fix. Unknown state starts outside without firing. */
  update(triggers: PlaceTrigger[], latitude: number, longitude: number): string[] {
    const fired: string[] = [];
    for (const trigger of triggers) {
      const distance = haversineMeters(latitude, longitude, trigger.latitude, trigger.longitude);
      const was = this.inside.get(trigger.sceneId);
      const now = was === undefined
        ? distance < trigger.radiusMeters
        : was ? distance < trigger.radiusMeters + HYSTERESIS_M : distance < trigger.radiusMeters;
      if (was === undefined) { this.inside.set(trigger.sceneId, now); continue; } // first fix only learns the state
      if (now === was) continue;
      this.inside.set(trigger.sceneId, now);
      if ((trigger.on === 'arrive' && now) || (trigger.on === 'leave' && !now)) fired.push(trigger.sceneId);
    }
    return fired;
  }

  reset(): void { this.inside.clear(); }
}
