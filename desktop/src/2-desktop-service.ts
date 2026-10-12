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
import { advertiseDesktop, type DesktopHint } from './transport/discovery/lan-discovery.js';
import { createWebSocketTransport, type TransportOptions } from './transport/websocket/websocket-server.js';
import { ClipboardSync } from './clipboard-sync/clipboard-sync.js';
import { createClipboard } from './os-integration/create-clipboard.js';
import type { ClipboardAdapter } from './os-integration/clipboard.js';
import { TransferStore } from './file-transfer/transfer-store.js';
import { FileTransfer } from './file-transfer/file-transfer.js';
import { AppLauncher } from './app-launcher/app-launcher.js';
import { createAppLauncher } from './os-integration/create-app-launcher.js';
import type { AppLauncherAdapter } from './os-integration/app-launcher.js';
import { InputControl } from './input-simulation/input-control.js';
import type { InputDevice } from './os-integration/input-device.js';
import type { BiometricConfirmation } from './security-pairing/biometric-confirmation.js';
import { DictationService } from './dictation/dictation-service.js';
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
  dictation?: { engine: Transcriber; cleanup?: () => CleanupOptions };
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
  try {
    const identity = await loadOrCreateIdentity(directory);
    const store = new FilePairedCredentialStore(join(directory, 'credentials.json'));
    const auth = new SessionAuth(store, log, options.sessionTtlMs);
    const registry = options.registry ?? new CommandRegistry();
    clipboard = new ClipboardSync(registry, options.clipboard?.createAdapter ?? createClipboard, log, options.clipboard?.pollMs);
    const inbox = options.inbox ? privateDirectory(options.inbox) : join(directory, 'received');
    files = new FileTransfer(new TransferStore(directory, inbox, 'to-desktop'), registry, log, owner => store.isActive(owner));
    launcher = new AppLauncher(registry, options.launcher?.createAdapter ?? createAppLauncher);
    if (options.agent) agent = new AgentTasks(registry, new TaskLedger(directory), options.agent.runner, new AuditTrail(directory), join(directory, 'agent-paused'));
    if (options.input) input = new InputControl(registry, options.input.createDevice, log, options.input.confirmation);
    if (options.dictation) dictation = new DictationService(registry, options.dictation.engine, log, options.dictation.cleanup);
    const router = new CommandRouter(registry, auth, log);
    const transportOptions: TransportOptions = { host: options.host, port: options.port,
      tls: { cert: identity.certificate, key: identity.privateKey }, router, auth, log };
    transport = createWebSocketTransport(transportOptions);
    const address = await transport.start();
    const host = options.host.includes(':') ? `[${options.host}]` : options.host;
    const hint: DesktopHint = { desktopServiceId: identity.desktopServiceId, displayName: options.displayName,
      endpoint: `wss://${host}:${address.port}/v1/channel`, certificate: identity.certificate };
    const pairing = new PairingService({ ...hint, certificateFingerprint: certificateFingerprint(identity.certificate) }, store, log);
    transportOptions.pairing = pairing;
    if (options.discovery !== false) discovery = advertiseDesktop(hint,
      () => log.record({ severity: 'warn', eventType: 'discovery.error', outcome: 'failed' }));
    let stopped = false;
    return { directory, pairing, hint, log, transport, auth, files, credentials: store,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        pairing.close();
        await dictation?.stop();
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
