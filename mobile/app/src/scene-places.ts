/** Place triggers for scenes: fires a scene when the phone arrives at or leaves a saved place. Foreground-only per platform. */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';
import { GeoTriggerEvaluator, type LauncherApi, type PlaceTrigger } from '@orbit/core';

type LocationModule = typeof import('expo-location');

let location: LocationModule | undefined;
try { if (Platform.OS !== 'web') location = require('expo-location') as LocationModule; } catch { location = undefined; }

const KEY = 'orbit.scene-places.v1';
const triggerSchema = z.strictObject({ sceneId: z.string(), latitude: z.number(), longitude: z.number(),
  radiusMeters: z.number().min(50).max(5000), on: z.enum(['arrive', 'leave']) });
const storeSchema = z.strictObject({ byDesktop: z.record(z.string(), z.array(triggerSchema).max(32)) });

export const scenePlacesAvailable = (): boolean => !!location;

async function readAll(): Promise<Record<string, PlaceTrigger[]>> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return {};
  try { return storeSchema.parse(JSON.parse(raw)).byDesktop; } catch { await SecureStore.deleteItemAsync(KEY); return {}; }
}

async function writeAll(byDesktop: Record<string, PlaceTrigger[]>): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify({ byDesktop }));
}

export async function placeTriggers(desktopServiceId: string): Promise<PlaceTrigger[]> {
  return (await readAll())[desktopServiceId] ?? [];
}

export async function setPlaceTrigger(desktopServiceId: string, trigger: PlaceTrigger): Promise<PlaceTrigger[]> {
  const all = await readAll();
  const list = (all[desktopServiceId] ?? []).filter(t => t.sceneId !== trigger.sceneId);
  list.push(trigger);
  all[desktopServiceId] = list;
  await writeAll(all);
  notifyTriggerListeners();
  return list;
}

export async function clearPlaceTrigger(desktopServiceId: string, sceneId: string): Promise<PlaceTrigger[]> {
  const all = await readAll();
  const list = (all[desktopServiceId] ?? []).filter(t => t.sceneId !== sceneId);
  all[desktopServiceId] = list;
  await writeAll(all);
  notifyTriggerListeners();
  return list;
}

export async function currentCoordinates(): Promise<{ latitude: number; longitude: number } | undefined> {
  if (!location) return undefined;
  const permission = await location.requestForegroundPermissionsAsync();
  if (!permission.granted) return undefined;
  const fix = await location.getCurrentPositionAsync({ accuracy: location.Accuracy.Balanced });
  return { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
}

/** Live watchers told when any trigger list changes, so a trigger added after connect still arms watching. */
const triggerListeners = new Set<() => void>();
const notifyTriggerListeners = (): void => { for (const l of [...triggerListeners]) l(); };

/** Watches the phone's position while Orbit is open and launches scenes whose place trigger fires. */
export class ScenePlaceWatcher {
  private readonly evaluator = new GeoTriggerEvaluator();
  private subscription?: { remove(): void };
  private lastLaunch = new Map<string, number>();
  private watching = false;
  private syncing = false;
  private dirty = false;
  private readonly onTriggersChanged = (): void => { void this.sync(); };

  constructor(private readonly desktopServiceId: string, private readonly launcher: LauncherApi,
    private readonly onLaunch: (sceneId: string) => void, private readonly onError: (message: string) => void) {}

  /** Arms watching when a trigger exists; sleeps (no permission prompt, no GPS) while none does. Re-checks on every trigger change. */
  start(): void {
    if (this.watching) return;
    this.watching = true;
    triggerListeners.add(this.onTriggersChanged);
    void this.sync();
  }

  private async sync(): Promise<void> {
    if (this.syncing) { this.dirty = true; return; }
    if (!this.watching) return;
    this.syncing = true;
    try {
      const loc = location;
      const wanted = !!loc && (await placeTriggers(this.desktopServiceId)).length > 0;
      if (!this.watching) return;
      if (!wanted || !loc) {
        this.subscription?.remove();
        this.subscription = undefined;
        this.evaluator.reset();
        return;
      }
      if (this.subscription) return;
      const permission = await loc.requestForegroundPermissionsAsync();
      if (!permission.granted) { this.onError('Orbit needs location access for place-based scenes'); return; }
      if (!this.watching) return; // stopped while the permission prompt was up
      const subscription = await loc.watchPositionAsync(
        { accuracy: loc.Accuracy.Balanced, timeInterval: 30_000, distanceInterval: 25 },
        fix => { void this.evaluate(fix.coords.latitude, fix.coords.longitude); });
      if (!this.watching) { subscription.remove(); return; } // stopped while subscribing
      this.subscription = subscription;
    } finally {
      this.syncing = false;
      if (this.dirty) { this.dirty = false; void this.sync(); }
    }
  }

  private async evaluate(latitude: number, longitude: number): Promise<void> {
    const triggers = await placeTriggers(this.desktopServiceId);
    for (const sceneId of this.evaluator.update(triggers, latitude, longitude)) {
      const last = this.lastLaunch.get(sceneId) ?? 0;
      if (Date.now() - last < 10 * 60_000) continue; // never relaunch the same scene within ten minutes
      this.lastLaunch.set(sceneId, Date.now());
      try { await this.launcher.launchScene(sceneId); this.onLaunch(sceneId); }
      catch (e) { this.onError(e instanceof Error ? e.message : String(e)); }
    }
  }

  stop(): void {
    this.watching = false;
    triggerListeners.delete(this.onTriggersChanged);
    this.subscription?.remove();
    this.subscription = undefined;
    this.evaluator.reset();
  }
}
