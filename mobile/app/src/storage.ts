/** Keeps the paired desktop record in the OS secure store; nothing else may hold the credential. */
import * as SecureStore from 'expo-secure-store';
import { pairedDesktopSchema, type PairedDesktop } from '@orbit/core';

const KEY = 'orbit.paired-desktop.v1';

export async function loadPaired(): Promise<PairedDesktop | undefined> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return undefined;
  try { return pairedDesktopSchema.parse(JSON.parse(raw)); } catch { await SecureStore.deleteItemAsync(KEY); return undefined; }
}
export async function savePaired(paired: PairedDesktop): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(pairedDesktopSchema.parse(paired)), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}
export async function clearPaired(): Promise<void> { await SecureStore.deleteItemAsync(KEY); }

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
