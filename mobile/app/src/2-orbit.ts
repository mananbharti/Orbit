/** Wires the shared core to the phone: one session, one task store, one paired desktop. */
import * as Crypto from 'expo-crypto';
import { AgentApi, ClipboardApi, FileApi, InputApi, LauncherApi, MemoryApi, OrbitSession, TaskStore, describeError, pairWithQr, type PairedDesktop } from '@orbit/core';
import { fileEnv } from './files';
import { createNativeTransport } from './native-transport';
import { clearPaired, savePaired } from './storage';

const uuid = (): string => Crypto.randomUUID();
const transport = createNativeTransport(uuid);

export interface Connected { paired: PairedDesktop; session: OrbitSession; store: TaskStore; api: AgentApi; launcher: LauncherApi; clipboard: ClipboardApi; files: FileApi; input: InputApi; memory: MemoryApi }

export async function pair(qrText: string): Promise<PairedDesktop> {
  const paired = await pairWithQr(qrText, transport);
  await savePaired(paired);
  return paired;
}

export function connect(paired: PairedDesktop): Connected {
  const session = new OrbitSession(paired, transport, { uuid });
  const api = new AgentApi(session, uuid);
  const store = new TaskStore(session, api);
  const launcher = new LauncherApi(session);
  const clipboard = new ClipboardApi(session);
  const files = new FileApi(session, fileEnv);
  const input = new InputApi(session);
  const memory = new MemoryApi(session);
  void session.start().catch(() => { /* status listeners report it; the session retries or asks to re-pair */ });
  return { paired, session, store, api, launcher, clipboard, files, input, memory };
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
