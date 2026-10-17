/** Keeps the paired desktop record in the OS secure store; nothing else may hold the credential. */
import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';
import { pairedDesktopSchema, type PairedDesktop } from '@orbit/core';

const KEY = 'orbit.paired-desktop.v1';
const LIST_KEY = 'orbit.paired-desktops.v1';
const ACTIVE_KEY = 'orbit.active-desktop.v1';

export async function loadPaired(): Promise<PairedDesktop | undefined> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return undefined;
  try { return pairedDesktopSchema.parse(JSON.parse(raw)); } catch { await SecureStore.deleteItemAsync(KEY); return undefined; }
}

/** Every computer this phone has paired, plus which one is active. Migrates the single-desktop record on first read. */
export async function loadPairedList(): Promise<{ list: PairedDesktop[]; activeId?: string }> {
  const raw = await SecureStore.getItemAsync(LIST_KEY);
  if (raw) {
    try {
      const list = z.array(pairedDesktopSchema).max(8).parse(JSON.parse(raw));
      const activeId = await SecureStore.getItemAsync(ACTIVE_KEY) ?? undefined;
      return { list, activeId: list.some(d => d.desktopServiceId === activeId) ? activeId : list[0]?.desktopServiceId };
    } catch { await SecureStore.deleteItemAsync(LIST_KEY); }
  }
  const single = await loadPaired(); // one-time migration from the single-desktop record
  if (!single) return { list: [] };
  await savePairedList([single], single.desktopServiceId);
  await SecureStore.deleteItemAsync(KEY);
  return { list: [single], activeId: single.desktopServiceId };
}

export async function savePairedList(list: PairedDesktop[], activeId?: string): Promise<void> {
  await SecureStore.setItemAsync(LIST_KEY, JSON.stringify(z.array(pairedDesktopSchema).max(8).parse(list)), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (activeId) await SecureStore.setItemAsync(ACTIVE_KEY, activeId);
}

/** Rewrites one computer's record in place (used when its network address changes). */
export async function updatePaired(paired: PairedDesktop): Promise<void> {
  const { list, activeId } = await loadPairedList();
  if (!list.some(d => d.desktopServiceId === paired.desktopServiceId)) return;
  await savePairedList(list.map(d => d.desktopServiceId === paired.desktopServiceId ? paired : d), activeId);
}

/** Adds or replaces one computer (same desktopServiceId re-pairs) and makes it active. */
export async function upsertPaired(list: PairedDesktop[], paired: PairedDesktop): Promise<PairedDesktop[]> {
  const next = [...list.filter(d => d.desktopServiceId !== paired.desktopServiceId), paired];
  await savePairedList(next, paired.desktopServiceId);
  return next;
}

/** Removes one computer; returns the remaining list and the new active id. */
export async function removePaired(list: PairedDesktop[], desktopServiceId: string, activeId?: string): Promise<{ list: PairedDesktop[]; activeId?: string }> {
  const next = list.filter(d => d.desktopServiceId !== desktopServiceId);
  const nextActive = activeId === desktopServiceId ? next[0]?.desktopServiceId : activeId;
  await savePairedList(next, nextActive);
  if (!nextActive) await SecureStore.deleteItemAsync(ACTIVE_KEY);
  return { list: next, activeId: nextActive };
}

const THEME_KEY = 'orbit.theme.v1';
export async function loadThemePref(): Promise<'auto' | 'light' | 'dark'> {
  try { const v = await SecureStore.getItemAsync(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch { return 'auto'; }
}
export async function saveThemePref(pref: 'auto' | 'light' | 'dark'): Promise<void> {
  try { await SecureStore.setItemAsync(THEME_KEY, pref); } catch { /* preference is cosmetic; ignore */ }
}

const CLIP_AUTO_KEY = 'orbit.clipboard-autosync.v1';
export async function loadClipboardAuto(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(CLIP_AUTO_KEY)) !== 'off'; } catch { return true; }
}
export async function saveClipboardAuto(on: boolean): Promise<void> {
  try { await SecureStore.setItemAsync(CLIP_AUTO_KEY, on ? 'on' : 'off'); } catch { /* cosmetic; ignore */ }
}

const LOCK_KEY = 'orbit.app-lock.v1';
export async function loadAppLock(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(LOCK_KEY)) !== 'off'; } catch { return true; } // on by default: pairing is a powerful credential
}
export async function saveAppLock(on: boolean): Promise<void> {
  try { await SecureStore.setItemAsync(LOCK_KEY, on ? 'on' : 'off'); } catch { /* preference; ignore */ }
}
