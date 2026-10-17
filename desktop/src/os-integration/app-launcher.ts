/** Defines native app discovery and activation capabilities; depends on abort signals; carries local registration data, never wire-supplied paths. */
export interface NativeApp { key: string; name: string; revision: string; target?: string }
export interface AppLauncherAdapter {
  list(signal: AbortSignal): Promise<NativeApp[]>;
  launch(app: NativeApp, authorize: () => void, signal: AbortSignal): Promise<void>;
  /** Small PNG (base64) for the app's own icon, or null. Optional: launchers without icon support omit it. */
  icon?(app: NativeApp, signal: AbortSignal): Promise<string | null>;
}
