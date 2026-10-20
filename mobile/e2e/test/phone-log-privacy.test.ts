/** The activity log is metadata only: nothing a phone sends or reads, and no credential, ever appears in it. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { AgentApi } from '../../core/src/agent.js';
import { ClipboardApi } from '../../core/src/clipboard.js';
import { FileApi, type FileSource } from '../../core/src/files.js';
import { MemoryApi } from '../../core/src/memory.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { TerminalApi } from '../../core/src/terminal.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

test('after clipboard, memory, files, terminal and agent use, the activity log holds no payload and no credential', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-logpriv-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    terminal: { confirmation: { verify: async () => true } },
    agent: { runner: { run: async ctx => { ctx.output('AGENTOUT-9f2'); return 'RESULT-9f2'; } } } });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  await session.start();

  const secrets = ['CLIPSECRET-7a1', 'MEMSECRET-7a1', 'FILESECRET-7a1', 'TERMSECRET-7a1', 'PROMPTSECRET-7a1'];
  const clipboard = new ClipboardApi(session);
  await clipboard.send(secrets[0]!).catch(() => undefined);
  await clipboard.stop().catch(() => undefined);
  await new MemoryApi(session).remember({ name: secrets[1]!, fact: 'FACTSECRET-7a1' });
  const data = Buffer.from('payload');
  const source: FileSource = { name: `${secrets[2]}.txt`, size: data.length, sha256: async () => createHash('sha256').update(data).digest('hex'),
    read: async (o, l) => new Uint8Array(data.subarray(o, o + l)) };
  const files = new FileApi(session, { uuid: randomUUID, sha256Bytes: async b => createHash('sha256').update(b).digest('hex') }, 10);
  await files.upload(source); files.dispose();
  const terminal = new TerminalApi(session);
  await terminal.begin(); await terminal.exec(`echo ${secrets[3]}`); await terminal.end(); terminal.dispose();
  const task = await new AgentApi(session, randomUUID).submit(secrets[4]!);
  await new Promise(r => setTimeout(r, 300));
  session.stop();

  const log = JSON.stringify(service.log.snapshot());
  assert.ok(service.log.snapshot().length > 10, 'the log recorded real activity');
  for (const needle of [...secrets, 'FACTSECRET-7a1', 'AGENTOUT-9f2', 'RESULT-9f2', paired.credential, qr.pairingToken, task.taskId]) {
    assert.ok(!log.includes(needle), `the log must not contain ${needle.slice(0, 12)}...`);
  }
});
