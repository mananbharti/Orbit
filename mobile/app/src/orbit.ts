/** Wires the shared core to the phone: one session, one task store, one paired desktop. */
import * as Crypto from 'expo-crypto';
import { AgentApi, ClipboardApi, DictationApi, FileApi, InputApi, LauncherApi, MemoryApi, OrbitSession, SystemApi, TaskStore, createLocator, describeError, pairWithQr, type PairedDesktop } from '@orbit/core';
import { fileEnv } from './files';
import { createNativeDiscovery, createNativeTransport } from './native-transport';
import { clearPaired, savePaired } from './storage';

const uuid = (): string => Crypto.randomUUID();
const transport = createNativeTransport(uuid);
const discovery = createNativeDiscovery();
const locator = createLocator({ transport, discover: discovery.discover, localAddress: discovery.localAddress });

export interface Connected { paired: PairedDesktop; session: OrbitSession; store: TaskStore; api: AgentApi; launcher: LauncherApi; clipboard: ClipboardApi; files: FileApi; input: InputApi; memory: MemoryApi; dictation: DictationApi; system: SystemApi }

export async function pair(qrText: string): Promise<PairedDesktop> {
  const paired = await pairWithQr(qrText, transport);
  await savePaired(paired);
  return paired;
}

export function connect(paired: PairedDesktop): Connected {
  // If the computer's address changes (new Wi-Fi, new IP), the session finds it again by its pinned certificate and we remember the new address.
  const session = new OrbitSession(paired, transport, { uuid, locator,
    onEndpointChanged: endpoint => { void savePaired({ ...paired, endpoint }); } });
  const api = new AgentApi(session, uuid);
  const store = new TaskStore(session, api);
  const launcher = new LauncherApi(session);
  const clipboard = new ClipboardApi(session);
  const files = new FileApi(session, fileEnv);
  const input = new InputApi(session);
  const memory = new MemoryApi(session);
  const dictation = new DictationApi(session);
  const system = new SystemApi(session);
  void session.start().catch(() => { /* status listeners report it; the session retries or asks to re-pair */ });
  // Clipboard sync is app-wide, not screen-bound: subscribe now so computer -> phone lands instantly.
  void clipboard.start().catch(() => { /* retried on the next reconnect */ });
  return { paired, session, store, api, launcher, clipboard, files, input, memory, dictation, system };
}

export async function forget(connected: Connected | undefined): Promise<void> {
  connected?.store.dispose();
  connected?.clipboard.dispose();
  connected?.files.dispose();
  connected?.input.dispose();
  connected?.session.stop();
  await clearPaired();
}

export const friendlyError = describeError;
