import { Platform } from 'react-native';

export type AndroidShare = { files: string[]; text?: string | null };
type NativeShareModule = { drainPendingShares(): Promise<AndroidShare[] | null> };
type Subscription = { remove(): void };
type NativeEvents = { addListener(event: 'orbitShared', listener: (share: AndroidShare) => void): Subscription };

let mod: (NativeShareModule & NativeEvents) | undefined;
try {
  if (Platform.OS === 'android') {
    const { requireNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    mod = requireNativeModule<NativeShareModule & NativeEvents>('OrbitShareIntake');
  }
} catch { mod = undefined; }

export const androidShareAvailable = (): boolean => !!mod;

/**
 * Delivers files and text other Android apps shared into Orbit. Drains anything buffered while
 * React Native booted, then reports new shares as they arrive. Returns an unsubscribe.
 */
export function onAndroidShare(onShare: (share: AndroidShare) => void): () => void {
  if (!mod) return () => {};
  const sub = mod.addListener('orbitShared', onShare);
  void mod.drainPendingShares().then(list => list?.forEach(onShare)).catch(() => undefined);
  return () => sub.remove();
}
