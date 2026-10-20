/** Scope enforcement across the whole command surface: a phone paired for one family can reach nothing outside it. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

const COMMANDS = ['agent.approve', 'agent.audit', 'agent.cancel', 'agent.get', 'agent.list', 'agent.pause', 'agent.resume', 'agent.retry', 'agent.status', 'agent.submit',
  'automation.delete', 'automation.enable', 'automation.list', 'automation.save',
  'clipboard.apply', 'clipboard.history', 'clipboard.subscribe', 'clipboard.unsubscribe', 'clipboard.write',
  'dictation.begin', 'dictation.cancel', 'dictation.chunk', 'dictation.finish',
  'file.accept', 'file.cancel', 'file.chunk', 'file.finish', 'file.offer', 'file.offers', 'file.read', 'file.resume', 'file.status', 'file.subscribe', 'file.unsubscribe',
  'input.begin', 'input.end', 'input.macro.delete', 'input.macro.save', 'input.macros', 'input.send',
  'launcher.icon', 'launcher.launch', 'launcher.list', 'launcher.pin', 'launcher.reorder', 'launcher.scene.delete', 'launcher.scene.launch', 'launcher.scene.save', 'launcher.scenes', 'launcher.unpin',
  'memory.forget', 'memory.recall', 'memory.remember',
  'pair.devices', 'pair.revoke', 'pair.scopes.set',
  'system.audio.session.set', 'system.audio.sessions', 'system.brightness.get', 'system.brightness.set', 'system.mode.get', 'system.mode.set', 'system.panic', 'system.power', 'system.volume.get', 'system.volume.set',
  'tabs.activate', 'tabs.close', 'tabs.list', 'tabs.open', 'tabs.status',
  'terminal.begin', 'terminal.end', 'terminal.exec', 'terminal.interrupt'];
const FAMILY: Record<string, string> = { file: 'files' };

test('a phone scoped to one family is denied every command outside that family, including system, terminal, tabs, automation and device management', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-scopes-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    terminal: { confirmation: { verify: async () => false } },
    input: { createDevice: () => ({ open: async () => {}, apply: async () => {}, releaseAll: async () => {}, dispose: async () => {} }), confirmation: { verify: async () => false } },
    agent: { runner: { run: async () => 'done' } },
    dictation: { engine: { transcribe: async () => 'x' }, cleanup: () => ({ dictionary: {} }) } });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  for (const scope of ['agent', 'clipboard', 'files', 'launcher', 'input', 'dictation', 'memory']) {
    const transport = new NodePinnedTransport(new Map());
    const qr = service.pairing.open([scope] as never);
    (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
    const session = new OrbitSession(await pairWithQr(JSON.stringify(qr), transport), transport, { uuid: randomUUID });
    t.after(() => session.stop());
    await session.start();
    const leaks: string[] = [];
    for (const type of COMMANDS) {
      const family = type.split('.')[0]!;
      if ((FAMILY[family] ?? family) === scope) continue;
      try { await session.command(type, {}); leaks.push(`${type}: succeeded`); }
      catch (e) { if (!(e instanceof CommandError) || e.code !== 'SCOPE_DENIED') leaks.push(`${type}: ${e instanceof CommandError ? e.code : String(e)}`); }
    }
    assert.deepEqual(leaks, [], `scope ${scope} must be denied everything outside its family`);
  }
});
