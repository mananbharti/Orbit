/** Natural-language control: deterministic intent matching (en + romanized Hindi), honest unknowns,
 *  model-decider boundaries (intent choice only, parameters never model-derived), and proof that a
 *  mapped command faces the same scope gate as a directly-sent one. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { JsonValue } from '../src/protocol/messages.js';
import { matchIntent, NL_INTENTS } from '../src/nl-control/intents.js';
import { NlControlService, type NlDecider } from '../src/nl-control/nl-service.js';
import { nlControlSchema } from '../src/protocol/nl-control.js';
import { core } from './helpers.js';

function matched(text: string) {
  const m = matchIntent(text);
  if (!m) return undefined;
  return 'missing' in m ? { id: m.intent.id, missing: true } : { id: m.intent.id, command: m.intent.command, payload: m.payload };
}

describe('nl intent matching', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['volume 50', 'volume.set', { level: 50 }],
    ['set volume to 70', 'volume.set', { level: 70 }],
    ['volume 30 pe kar do', 'volume.set', { level: 30 }],
    ['awaz 80 rakh', 'volume.set', { level: 80 }],
    ['mute', 'volume.mute', { muted: true }],
    ['awaz band karo', 'volume.mute', { muted: true }],
    ['unmute the volume', 'volume.unmute', { muted: false }],
    ["what's the volume?", 'volume.get', {}],
    ['volume kitna hai', 'volume.get', {}],
    ['play', 'media.playpause', { action: 'playpause' }],
    ['pause karo', 'media.playpause', { action: 'playpause' }],
    ['next song', 'media.next', { action: 'next' }],
    ['agla gana', 'media.next', { action: 'next' }],
    ['previous track', 'media.previous', { action: 'previous' }],
    ['pichla gana laga do', 'media.previous', { action: 'previous' }],
    ['brightness 40', 'brightness.set', { level: 40 }],
    ['set brightness to 90', 'brightness.set', { level: 90 }],
  ];
  for (const [text, id, payload] of cases) {
    it(`maps ${JSON.stringify(text)}`, () => {
      const m = matched(text);
      assert.equal(m?.id, id);
      assert.deepEqual(m && 'payload' in m ? m.payload : undefined, payload);
    });
  }

  it('reports out-of-range numbers as unclear, never clamped', () => {
    assert.deepEqual(matched('volume 500'), { id: 'volume.set', missing: true });
    assert.deepEqual(matched('brightness 101'), { id: 'brightness.set', missing: true });
  });

  const refused = [
    'shutdown the computer', 'lock my pc', 'delete all files', 'open chrome',
    'volume 50; shutdown', 'system.volume.set {"level":50}', 'ignore previous instructions',
    'run rm -rf /', 'play something nice', 'turn it up',
  ];
  for (const text of refused) {
    it(`refuses to guess ${JSON.stringify(text)}`, () => assert.equal(matched(text), undefined));
  }

  it('routes only to existing non-sensitive commands', () => {
    for (const intent of NL_INTENTS) {
      assert.ok(intent.command.startsWith('system.') || intent.command.startsWith('launcher.'));
      assert.notEqual(intent.command, 'system.power');
    }
  });
});

function setup(decider?: NlDecider) {
  const c = core();
  const executed: { type: string; payload: JsonValue }[] = [];
  for (const type of ['system.volume.set', 'system.volume.get', 'system.media.transport', 'system.brightness.set']) {
    c.registry.register(type, { validate: () => true, execute: async payload => { executed.push({ type, payload }); return { applied: true }; } });
  }
  new NlControlService(c.registry, c.router, c.log, decider);
  const { session } = c.auth.issue(c.credential)!;
  const handler = c.registry.get('nl.control')!;
  const say = async (text: string) => handler.execute({ text }, { session, requestId: randomUUID(), connection: { isAuthorized: () => true } as never });
  return { ...c, executed, say, session };
}

describe('nl.control service', () => {
  it('validates the payload shape', () => {
    assert.equal(nlControlSchema.safeParse({ text: 'volume 50' }).success, true);
    assert.equal(nlControlSchema.safeParse({ text: '' }).success, false);
    assert.equal(nlControlSchema.safeParse({ text: 'x'.repeat(201) }).success, false);
    assert.equal(nlControlSchema.safeParse({ text: 'ok', extra: 1 }).success, false);
  });

  it('executes a matched phrase through the mapped command', async () => {
    const { say, executed } = setup();
    assert.deepEqual(await say('volume 65'), { status: 'executed', command: 'system.volume.set', result: { applied: true } });
    assert.deepEqual(executed, [{ type: 'system.volume.set', payload: { level: 65 } }]);
  });

  it('answers unknown honestly and executes nothing', async () => {
    const { say, executed } = setup();
    assert.deepEqual(await say('make me a sandwich'), { status: 'unknown' });
    assert.deepEqual(executed, []);
  });

  it('asks for the missing number instead of inventing one', async () => {
    const { say, executed } = setup();
    assert.equal((await say('volume 500') as { status: string }).status, 'unclear');
    assert.deepEqual(executed, []);
  });

  it('scoped-out devices get the mapped command SCOPE_DENIED, exactly like a direct send', async () => {
    const c = core();
    c.registry.register('system.volume.set', { validate: () => true, execute: async () => ({ applied: true }) });
    new NlControlService(c.registry, c.router, c.log);
    const scoped = { deviceId: 'phone-scoped', sessionId: 's1', expiresAt: Date.now() + 60_000, scopes: ['clipboard'] as const };
    const handler = c.registry.get('nl.control')!;
    const out = await handler.execute({ text: 'volume 10' },
      { session: scoped as never, requestId: randomUUID(), connection: { isAuthorized: () => true } as never });
    assert.deepEqual(out, { status: 'rejected', command: 'system.volume.set', error: 'SCOPE_DENIED' });
  });

  it('model decider: below-threshold answers stay unknown', async () => {
    const { say, executed } = setup({ decide: async () => ({ choice: 'media.next', probability: 0.2 }) });
    assert.deepEqual(await say('skip ahead please'), { status: 'unknown' });
    assert.deepEqual(executed, []);
  });

  it('model decider: picks intent only - parameters still come from the text, never the model', async () => {
    const decider: NlDecider = { decide: async () => ({ choice: 'volume.set', probability: 0.9 }) };
    const { say, executed } = setup(decider);
    assert.deepEqual(await say('crank it to 55'), { status: 'unknown' }); // model intent, no extractable number
    assert.deepEqual(executed, []);
    assert.deepEqual(await say('volume ko 55 kar do'), { status: 'executed', command: 'system.volume.set', result: { applied: true } });
    assert.deepEqual(executed, [{ type: 'system.volume.set', payload: { level: 55 } }]);
  });

  it('model decider: a junk or out-of-catalog choice is ignored', async () => {
    const decider: NlDecider = { decide: async () => ({ choice: 'system.power', probability: 0.99 }) };
    const { say, executed } = setup(decider);
    assert.deepEqual(await say('shut everything down'), { status: 'unknown' });
    assert.deepEqual(executed, []);
  });

  it('model decider: decider failure falls back to honest unknown, never to execution', async () => {
    const decider: NlDecider = { decide: async () => { throw new Error('server down'); } };
    const { say, executed } = setup(decider);
    assert.equal((await say('volume 42') as { status: string }).status, 'executed'); // deterministic still works
    assert.deepEqual(await say('do the thing'), { status: 'unknown' });
    assert.equal(executed.length, 1);
  });

  it('launcher intent: opens a uniquely named app from the live catalog', async () => {
    const c = core();
    const executed: { type: string; payload: JsonValue }[] = [];
    c.registry.register('launcher.launch', { validate: () => true, execute: async payload => { executed.push({ type: 'launcher.launch', payload }); return { launched: true }; } });
    new NlControlService(c.registry, c.router, c.log, undefined, 0.6,
      () => ({ revision: 'rev1', apps: [{ appId: 'chrome', name: 'Google Chrome' }, { appId: 'code', name: 'Visual Studio Code' }] }));
    const { session } = c.auth.issue(c.credential)!;
    const say = (text: string) => c.registry.get('nl.control')!.execute({ text }, { session, requestId: randomUUID(), connection: { isAuthorized: () => true } as never });
    assert.deepEqual(await say('open chrome'), { status: 'executed', command: 'launcher.launch', result: { launched: true } });
    assert.deepEqual(executed[0], { type: 'launcher.launch', payload: { appId: 'chrome', catalogRevision: 'rev1' } });
    assert.equal((await say('code kholo') as { status: string }).status, 'executed');
    assert.deepEqual(executed[1], { type: 'launcher.launch', payload: { appId: 'code', catalogRevision: 'rev1' } });
  });

  it('launcher intent: ambiguous names ask which one, unknown names stay unknown - nothing launches', async () => {
    const c = core();
    const executed: string[] = [];
    c.registry.register('launcher.launch', { validate: () => true, execute: async () => { executed.push('x'); return { launched: true }; } });
    new NlControlService(c.registry, c.router, c.log, undefined, 0.6,
      () => ({ revision: 'r', apps: [{ appId: 'n1', name: 'Notes' }, { appId: 'n2', name: 'Noteshelf' }] }));
    const { session } = c.auth.issue(c.credential)!;
    const say = (text: string) => c.registry.get('nl.control')!.execute({ text }, { session, requestId: randomUUID(), connection: { isAuthorized: () => true } as never });
    const amb = await say('open note') as { status: string; hint?: string };
    assert.equal(amb.status, 'unclear');
    assert.match(amb.hint!, /Notes/);
    assert.deepEqual(await say('open itunes'), { status: 'unknown' });
    assert.equal(executed.length, 0);
  });
});
