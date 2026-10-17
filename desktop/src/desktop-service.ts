/** Composes the desktop lifecycle; depends on paired transport, Clipboard Sync, File Transfer, App Launcher and Agent Tasks; does not implement mobile UI or later feature modules. */
import { join } from 'node:path';
import { ActivityLog } from './activity-log/activity-log.js';
import { CommandRegistry } from './command-router/command-registry.js';
import { CommandRouter } from './command-router/command-router.js';
import { privateDirectory } from './security-pairing/private-directory.js';
import { lockService } from './security-pairing/service-lock.js';
import { certificateFingerprint, loadOrCreateIdentity } from './security-pairing/desktop-identity.js';
import { FilePairedCredentialStore } from './security-pairing/paired-credential-store.js';
import { PairingService } from './security-pairing/pairing-service.js';
import { SessionAuth } from './security-pairing/session-auth.js';
import { lanMacAddresses } from './lan-address.js';
import { advertiseDesktop, type DesktopHint } from './transport/discovery/lan-discovery.js';
import { createWebSocketTransport, type TransportOptions } from './transport/websocket/websocket-server.js';
import { ClipboardSync } from './clipboard-sync/clipboard-sync.js';
import { ClipboardHistory } from './clipboard-sync/clipboard-history.js';
import { createClipboard } from './os-integration/create-clipboard.js';
import type { ClipboardAdapter } from './os-integration/clipboard.js';
import { TransferStore } from './file-transfer/transfer-store.js';
import { FileTransfer } from './file-transfer/file-transfer.js';
import { AppLauncher } from './app-launcher/app-launcher.js';
import { LauncherLayout } from './app-launcher/launcher-layout.js';
import { LauncherScenes } from './app-launcher/launcher-scenes.js';
import { createAppLauncher } from './os-integration/create-app-launcher.js';
import type { AppLauncherAdapter } from './os-integration/app-launcher.js';
import { InputControl } from './input-simulation/input-control.js';
import type { InputDevice } from './os-integration/input-device.js';
import type { BiometricConfirmation } from './security-pairing/biometric-confirmation.js';
import { MemoryService } from './memory/memory-service.js';
import { SystemControl } from './system-control/system-control.js';
import { AudioMixer } from './system-control/audio-mixer.js';
import { PanicLock } from './security-pairing/panic-lock.js';
import { createSystemControl } from './os-integration/create-system-control.js';
import { createAudioMixer } from './os-integration/create-audio-mixer.js';
import type { AudioMixerAdapter } from './os-integration/audio-mixer.js';
import type { SystemControlAdapter } from './os-integration/system-control.js';
import { GraphStore } from './memory/graph-store.js';
import { DictationService } from './dictation/dictation-service.js';
import type { AudioDecoder } from './dictation/ffmpeg-decoder.js';
import type { Transcriber } from './dictation/pipeline.js';
import type { CleanupOptions } from './dictation/cleanup.js';
import { AuditTrail } from './agent/audit-trail.js';
import { AgentTasks } from './agent/agent-tasks.js';
import type { AgentRunner } from './agent/agent-runner.js';
import { TaskLedger } from './agent/task-ledger.js';

export async function startDesktop(options: { directory: string; host: string; port: number; displayName: string;
  discovery?: boolean; sessionTtlMs?: number; registry?: CommandRegistry;
  clipboard?: { createAdapter: () => ClipboardAdapter; pollMs?: number }; inbox?: string;
  launcher?: { createAdapter: () => AppLauncherAdapter }; agent?: { runner: AgentRunner };
  /** Remote pointer/keyboard. Off unless a native device is supplied; every session still needs the desktop owner's confirmation. */
  /** Local speech-to-text for phone dictation. Off unless an engine is supplied. */
  /** Local graph memory. On by default; stored in the private data directory. */
  memory?: boolean;
  dictation?: { engine: Transcriber; cleanup?: () => CleanupOptions; decoder?: AudioDecoder };
  /** Power, volume and brightness control. On by default; pass a custom adapter to test. */
  system?: { createAdapter: () => SystemControlAdapter } | false;
  audioMixer?: { createAdapter: () => AudioMixerAdapter } | false;
  input?: { createDevice: () => InputDevice; confirmation?: BiometricConfirmation } }) {
  const directory = privateDirectory(options.directory);
  const unlock = lockService(directory);
  const log = new ActivityLog();
  let transport: ReturnType<typeof createWebSocketTransport> | undefined;
  let discovery: ReturnType<typeof advertiseDesktop> | undefined;
  let clipboard: ClipboardSync | undefined;
  let files: FileTransfer | undefined;
  let launcher: AppLauncher | undefined;
  let agent: AgentTasks | undefined;
  let input: InputControl | undefined;
  let dictation: DictationService | undefined;
  let memory: MemoryService | undefined;
  let system: SystemControl | undefined;
  let panic: PanicLock | undefined;
  let mixer: AudioMixer | undefined;
  try {
    const identity = await loadOrCreateIdentity(directory);
    const store = new FilePairedCredentialStore(join(directory, 'credentials.json'));
    const auth = new SessionAuth(store, log, options.sessionTtlMs);
    const registry = options.registry ?? new CommandRegistry();
    clipboard = new ClipboardSync(registry, options.clipboard?.createAdapter ?? createClipboard, log, options.clipboard?.pollMs, new ClipboardHistory(join(directory, 'clipboard-history.json')));
    const inbox = options.inbox ? privateDirectory(options.inbox) : join(directory, 'received');
    files = new FileTransfer(new TransferStore(directory, inbox, 'to-desktop'), registry, log, owner => store.isActive(owner));
    launcher = new AppLauncher(registry, options.launcher?.createAdapter ?? createAppLauncher,
      new LauncherLayout(join(directory, 'launcher-pins.json')), join(directory, 'launcher-secret'),
      new LauncherScenes(join(directory, 'launcher-scenes.json')));
    if (options.agent) agent = new AgentTasks(registry, new TaskLedger(directory), options.agent.runner, new AuditTrail(directory), join(directory, 'agent-paused'));
    if (options.input) input = new InputControl(registry, options.input.createDevice, log, options.input.confirmation);
    if (options.dictation) dictation = new DictationService(registry, options.dictation.engine, log, options.dictation.cleanup, undefined, options.dictation.decoder);
    if (options.memory !== false) memory = new MemoryService(registry, new GraphStore(join(directory, 'memory.json')), log);
    const systemFactory = options.system === false ? undefined : (options.system?.createAdapter ?? createSystemControl);
    if (systemFactory) system = new SystemControl(registry, systemFactory, log);
    panic = new PanicLock(registry, store, systemFactory, log);
    if (options.audioMixer !== false) mixer = new AudioMixer(registry, options.audioMixer?.createAdapter ?? createAudioMixer, log);
    const router = new CommandRouter(registry, auth, log);
    const transportOptions: TransportOptions = { host: options.host, port: options.port,
      tls: { cert: identity.certificate, key: identity.privateKey }, router, auth, log };
    transport = createWebSocketTransport(transportOptions);
    const address = await transport.start();
    const host = options.host.includes(':') ? `[${options.host}]` : options.host;
    const macAddresses = lanMacAddresses();
    const hint: DesktopHint = { desktopServiceId: identity.desktopServiceId, displayName: options.displayName,
      endpoint: `wss://${host}:${address.port}/v1/channel`, certificate: identity.certificate };
    const pairing = new PairingService({ ...hint, macAddresses, certificateFingerprint: certificateFingerprint(identity.certificate) }, store, log);
    transportOptions.pairing = pairing;
    if (options.discovery !== false) discovery = advertiseDesktop(hint,
      () => log.record({ severity: 'warn', eventType: 'discovery.error', outcome: 'failed' }));
    let stopped = false;
    return { directory, pairing, hint, log, transport, auth, files, credentials: store,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        pairing.close();
        system?.stop(); panic?.stop(); mixer?.stop();
        await dictation?.stop();
        memory?.stop();
        await input?.stop();
        await agent?.stop();
        await launcher!.stop();
        try { await files!.stop(); } finally { try { await clipboard!.stop(); } finally {
          try { await discovery?.stop(); } finally {
            try { await transport!.stop(); } finally { unlock(); }
          }
        } }
      } };
  } catch (error) {
    await dictation?.stop();
    await input?.stop();
    await agent?.stop();
    await launcher?.stop();
    try { await files?.stop(); } finally { try { await clipboard?.stop(); } finally {
      try { await discovery?.stop(); } finally {
        try { await transport?.stop(); } finally { unlock(); }
      }
    } }
    throw error;
  }
}
