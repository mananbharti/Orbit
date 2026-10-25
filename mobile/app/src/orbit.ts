/** Wires the shared core to the phone: one session, one task store, one paired desktop. */
import * as Crypto from 'expo-crypto';
import { AgentApi, AutomationApi, ClipboardApi, DevicesApi, TerminalApi, TabsApi, DictationApi, FileApi, InputApi, LauncherApi, MemoryApi, NlControlApi, OrbitSession, SystemApi, TaskStore, createLocator, describeError, pairWithQr, type PairedDesktop } from '@orbit/core';
import { fileEnv } from './files';
import { updatePaired } from './storage';
import { createNativeDiscovery, createNativeTransport } from './native-transport';


const uuid = (): string => Crypto.randomUUID();
const transport = createNativeTransport(uuid);
const discovery = createNativeDiscovery();
const locator = createLocator({ transport, discover: discovery.discover, localAddress: discovery.localAddress });

export interface Connected { paired: PairedDesktop; session: OrbitSession; store: TaskStore; api: AgentApi; launcher: LauncherApi; clipboard: ClipboardApi; files: FileApi; input: InputApi; memory: MemoryApi; dictation: DictationApi; system: SystemApi; devices: DevicesApi; automation: AutomationApi; terminal: TerminalApi; tabs: TabsApi; nl: NlControlApi }

export async function pair(qrText: string): Promise<PairedDesktop> {
  return pairWithQr(qrText, transport); // the caller upserts it into the paired list once the owner confirms
}

export function connect(paired: PairedDesktop): Connected {
  // If the computer's address changes (new Wi-Fi, new IP), the session finds it again by its pinned certificate and we remember the new address.
  const session = new OrbitSession(paired, transport, { uuid, locator,
    onEndpointChanged: endpoint => { void updatePaired({ ...paired, endpoint }); } });
  const api = new AgentApi(session, uuid);
  const store = new TaskStore(session, api);
  const launcher = new LauncherApi(session);
  const clipboard = new ClipboardApi(session);
  const files = new FileApi(session, fileEnv);
  const input = new InputApi(session);
  const memory = new MemoryApi(session);
  const dictation = new DictationApi(session);
  const system = new SystemApi(session);
  const devices = new DevicesApi(session);
  const automation = new AutomationApi(session);
  const terminal = new TerminalApi(session);
  const tabs = new TabsApi(session);
  const nl = new NlControlApi(session);
  void session.start().catch(() => { /* status listeners report it; the session retries or asks to re-pair */ });
  // Clipboard sync is app-wide, not screen-bound: subscribe now so computer -> phone lands instantly.
  void clipboard.start().catch(() => { /* retried on the next reconnect */ });
  return { paired, session, store, api, launcher, clipboard, files, input, memory, dictation, system, devices, automation, terminal, tabs, nl };
}

/** Stops the session and disposes per-connection state without unpairing; the computer stays in the paired list. */
export function disconnect(connected: Connected | undefined): void {
  connected?.store.dispose();
  connected?.clipboard.dispose();
  connected?.files.dispose();
  connected?.input.dispose();
  connected?.terminal.dispose();
  connected?.session.stop();
}


export const friendlyError = describeError;
