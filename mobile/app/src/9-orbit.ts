/** Wires the shared core to the phone: one session, one task store, one paired desktop. */
import * as Crypto from 'expo-crypto';
import { AgentApi, OrbitSession, PairingError, TaskStore, pairWithQr, type PairedDesktop } from '@orbit/core';
import { createNativeTransport } from './native-transport';
import { clearPaired, savePaired } from './storage';

const uuid = (): string => Crypto.randomUUID();
const transport = createNativeTransport(uuid);

export interface Connected { paired: PairedDesktop; session: OrbitSession; store: TaskStore }

export async function pair(qrText: string): Promise<PairedDesktop> {
  const paired = await pairWithQr(qrText, transport);
  await savePaired(paired);
  return paired;
}

export function connect(paired: PairedDesktop): Connected {
  const session = new OrbitSession(paired, transport, { uuid });
  const store = new TaskStore(session, new AgentApi(session, uuid));
  void session.start().catch(() => { /* status listeners report it; the session retries or asks to re-pair */ });
  return { paired, session, store };
}

export async function forget(connected: Connected | undefined): Promise<void> {
  connected?.store.dispose();
  connected?.session.stop();
  await clearPaired();
}

export const friendlyError = (error: unknown): string =>
  error instanceof PairingError || error instanceof Error ? error.message : 'Something went wrong';
