/**
 * Face ID / Touch ID gate for opening the paired connection. expo-local-authentication is a native
 * module, so it loads dynamically; without hardware or enrolled biometrics the gate stands open
 * (a phone with no biometrics must never lock the owner out of his own computer).
 */
import { Platform } from 'react-native';

type LocalAuth = { hasHardwareAsync: () => Promise<boolean>; isEnrolledAsync: () => Promise<boolean>;
  authenticateAsync: (options: { promptMessage: string; cancelLabel: string; disableDeviceFallback: boolean }) => Promise<{ success: boolean }> };

let moduleCache: LocalAuth | null | undefined;
function localAuth(): LocalAuth | null {
  if (Platform.OS === 'web') return null;
  if (moduleCache === undefined) {
    try { moduleCache = require('expo-local-authentication') as LocalAuth; } catch { moduleCache = null; }
  }
  return moduleCache;
}

/** True when a real biometric gate exists on this device (hardware + enrolled face/fingerprint). */
export async function biometricAvailable(): Promise<boolean> {
  const auth = localAuth();
  if (!auth) return false;
  try { return await auth.hasHardwareAsync() && await auth.isEnrolledAsync(); } catch { return false; }
}

/** Prompts for Face ID / Touch ID / device passcode. True when the gate cannot exist (no module or no enrollment). */
export async function authenticate(reason: string): Promise<boolean> {
  const auth = localAuth();
  if (!auth) return true;
  try {
    if (!(await auth.hasHardwareAsync()) || !(await auth.isEnrolledAsync())) return true;
    const result = await auth.authenticateAsync({ promptMessage: reason, cancelLabel: 'Cancel', disableDeviceFallback: false });
    return result.success;
  } catch { return false; }
}
