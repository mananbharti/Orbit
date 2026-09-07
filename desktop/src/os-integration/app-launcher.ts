/** Defines native app discovery and activation capabilities; depends on abort signals; carries local registration data, never wire-supplied paths. */
export interface NativeApp { key: string; name: string; revision: string }
export interface AppLauncherAdapter {
  list(signal: AbortSignal): Promise<NativeApp[]>;
  launch(app: NativeApp, authorize: () => void, signal: AbortSignal): Promise<void>;
}
