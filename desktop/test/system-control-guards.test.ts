/** Tests the System Control and Audio Mixer command guards directly on a registry: authorization, lazy adapter, error mapping and activity logging; depends on fake adapters only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import type { CommandConnection, CommandContext } from '../src/command-router/command-context.js';
import { AudioMixer } from '../src/system-control/audio-mixer.js';
import { SystemControl } from '../src/system-control/system-control.js';
import { SystemControlUnavailable, type SystemControlAdapter } from '../src/os-integration/system-control.js';
import { AudioMixerUnavailable, type AudioMixerAdapter } from '../src/os-integration/audio-mixer.js';
import { ProtocolError } from '../src/protocol/errors.js';

function context(authorized: boolean | 'none' = true): CommandContext {
  const connection: CommandConnection = { id: 'c', closed: new AbortController().signal, isAuthorized: () => authorized === true, publish: () => {} };
  return { session: { deviceId: 'phone-9', sessionId: 's', expiresAt: Date.now() + 60_000 }, requestId: 'r', ...(authorized === 'none' ? {} : { connection }) };
}
function systemFixture(behaviour: (name: string) => Promise<unknown> = async () => undefined) {
  const registry = new CommandRegistry();
  const log = new ActivityLog();
  const calls: string[] = [];
  let created = 0;
  const adapter: SystemControlAdapter = {
    power: async a => { calls.push(`power:${a}`); await behaviour('power'); },
    getVolume: async () => { await behaviour('getVolume'); return { level: 1, muted: false }; },
    setVolume: async () => { await behaviour('setVolume'); },
    getBrightness: async () => { await behaviour('getBrightness'); return 5; },
    setBrightness: async () => { await behaviour('setBrightness'); },
    getDisplayMode: async () => ({ theme: 'dark', nightLight: null }),
    setDisplayMode: async () => {},
  };
  const control = new SystemControl(registry, () => { created++; return adapter; }, log);
  const run = (type: string, payload: object, ctx = context()) => registry.get(type)!.execute(payload as never, ctx);
  return { control, log, calls, run, created: () => created };
}

test('system commands need an authorized connection and never create the adapter or act without one', async () => {
  const f = systemFixture();
  for (const ctx of [context(false), context('none')]) {
    await assert.rejects(f.run('system.power', { action: 'lock' }, ctx), /UNAUTHENTICATED/);
    await assert.rejects(f.run('system.volume.get', {}, ctx), /UNAUTHENTICATED/);
  }
  assert.equal(f.created(), 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.log.snapshot(), []);
});

test('system success and failure are logged with the device id; adapter errors become SYSTEM_UNAVAILABLE; protocol errors pass through', async () => {
  let mode: 'ok' | 'unavailable' | 'boom' | 'busy' = 'ok';
  const f = systemFixture(async () => {
    if (mode === 'unavailable') throw new SystemControlUnavailable();
    if (mode === 'boom') throw new Error('native crash');
    if (mode === 'busy') throw new ProtocolError('BUSY');
  });
  await f.run('system.volume.get', {});
  assert.deepEqual(f.log.snapshot().map(e => [e.eventType, e.outcome, e.deviceId]), [['system.volume', 'success', 'phone-9']]);
  mode = 'unavailable';
  await assert.rejects(f.run('system.volume.get', {}), /SYSTEM_UNAVAILABLE/);
  mode = 'boom';
  await assert.rejects(f.run('system.brightness.get', {}), /SYSTEM_UNAVAILABLE/);
  mode = 'busy';
  await assert.rejects(f.run('system.volume.get', {}), /BUSY/);
  const failed = f.log.snapshot().filter(e => e.outcome === 'failed');
  assert.equal(failed.length, 3);
  assert.ok(failed.every(e => e.severity === 'warn' && e.deviceId === 'phone-9'));
  assert.equal(f.created(), 1, 'one adapter serves every command');
});

test('powerLocal needs no phone session and shares the lazily created adapter', async () => {
  const f = systemFixture();
  await f.control.powerLocal('sleep');
  await f.run('system.volume.get', {});
  await f.control.powerLocal('lock');
  assert.equal(f.created(), 1);
  assert.deepEqual(f.calls, ['power:sleep', 'power:lock']);
});

function audioFixture(behaviour: () => Promise<unknown> = async () => undefined, sessions: unknown[] = []) {
  const registry = new CommandRegistry();
  const log = new ActivityLog();
  let created = 0;
  const adapter: AudioMixerAdapter = { listSessions: async () => { await behaviour(); return sessions as never; }, setSession: async () => { await behaviour(); } };
  new AudioMixer(registry, () => { created++; return adapter; }, log);
  const run = (type: string, payload: object, ctx = context()) => registry.get(type)!.execute(payload as never, ctx);
  return { log, run, created: () => created };
}

test('audio mixer needs authorization, logs outcomes with the device id, and maps errors', async () => {
  let mode: 'ok' | 'unavailable' | 'boom' | 'busy' = 'ok';
  const f = audioFixture(async () => {
    if (mode === 'unavailable') throw new AudioMixerUnavailable();
    if (mode === 'boom') throw new Error('com failure');
    if (mode === 'busy') throw new ProtocolError('BUSY');
  });
  await assert.rejects(f.run('system.audio.sessions', {}, context(false)), /UNAUTHENTICATED/);
  await assert.rejects(f.run('system.audio.sessions', {}, context('none')), /UNAUTHENTICATED/);
  assert.equal(f.created(), 0);
  assert.deepEqual(f.log.snapshot(), []);
  await f.run('system.audio.sessions', {});
  assert.deepEqual(f.log.snapshot().map(e => [e.eventType, e.outcome, e.deviceId]), [['system.audio', 'success', 'phone-9']]);
  mode = 'unavailable';
  await assert.rejects(f.run('system.audio.session.set', { id: '42', level: 5 }), /SYSTEM_UNAVAILABLE/);
  mode = 'boom';
  await assert.rejects(f.run('system.audio.sessions', {}), /SYSTEM_UNAVAILABLE/);
  mode = 'busy';
  await assert.rejects(f.run('system.audio.sessions', {}), /BUSY/);
  const failed = f.log.snapshot().filter(e => e.outcome === 'failed');
  assert.equal(failed.length, 3);
  assert.ok(failed.every(e => e.severity === 'warn' && e.deviceId === 'phone-9'));
  assert.equal(f.created(), 1);
});

function mediaFixture(opts: { withDevice?: boolean; applyError?: Error } = {}) {
  const registry = new CommandRegistry();
  const log = new ActivityLog();
  const keys: string[] = [];
  let created = 0;
  const adapter: SystemControlAdapter = {
    power: async () => {}, getVolume: async () => ({ level: 1, muted: false }), setVolume: async () => {},
    getBrightness: async () => 5, setBrightness: async () => {},
    getDisplayMode: async () => ({ theme: 'dark', nightLight: null }), setDisplayMode: async () => {},
  };
  const createInputDevice = opts.withDevice === false ? undefined : () => {
    created++;
    return { apply: async (event: { t: string; key?: string }) => { if (opts.applyError) throw opts.applyError; keys.push(String(event.key)); }, releaseAll: async () => {} } as never;
  };
  new SystemControl(registry, () => adapter, log, createInputDevice);
  const run = (type: string, payload: object, ctx = context()) => registry.get(type)!.execute(payload as never, ctx);
  return { log, keys, run, created: () => created };
}

test('media transport sends one media key per authorized command and logs it', async () => {
  const f = mediaFixture();
  await f.run('system.media.transport', { action: 'playpause' });
  await f.run('system.media.transport', { action: 'next' });
  assert.deepEqual(f.keys, ['playpause', 'next']);
  assert.equal(f.created(), 1); // the device is created once and reused
  assert.deepEqual(f.log.snapshot().map(e => [e.eventType, e.outcome, e.deviceId]),
    [['system.media', 'success', 'phone-9'], ['system.media', 'success', 'phone-9']]);
});

test('media transport needs an authorized connection and never creates the input device without one', async () => {
  const f = mediaFixture();
  for (const ctx of [context(false), context('none')]) {
    await assert.rejects(f.run('system.media.transport', { action: 'playpause' }, ctx), /UNAUTHENTICATED/);
  }
  assert.equal(f.created(), 0);
  assert.deepEqual(f.keys, []);
  assert.deepEqual(f.log.snapshot(), []);
});

test('media transport rejects bad payloads at validation', () => {
  const registry = new CommandRegistry();
  const log = new ActivityLog();
  const adapter: SystemControlAdapter = {
    power: async () => {}, getVolume: async () => ({ level: 1, muted: false }), setVolume: async () => {},
    getBrightness: async () => 5, setBrightness: async () => {},
    getDisplayMode: async () => ({ theme: 'dark', nightLight: null }), setDisplayMode: async () => {},
  };
  new SystemControl(registry, () => adapter, log, () => ({ apply: async () => {}, releaseAll: async () => {} } as never));
  const handler = registry.get('system.media.transport')!;
  assert.equal(handler.validate({ action: 'stop' } as never), false);
  assert.equal(handler.validate({ action: 'playpause', extra: 1 } as never), false);
  assert.equal(handler.validate({} as never), false);
  assert.equal(handler.validate({ action: 'previous' } as never), true);
});

test('media transport without an input device, or with a failing one, is SYSTEM_UNAVAILABLE and logged as failed', async () => {
  const none = mediaFixture({ withDevice: false });
  await assert.rejects(none.run('system.media.transport', { action: 'playpause' }), /SYSTEM_UNAVAILABLE/);
  const boom = mediaFixture({ applyError: new Error('no display') });
  await assert.rejects(boom.run('system.media.transport', { action: 'next' }), /SYSTEM_UNAVAILABLE/);
  for (const f of [none, boom]) {
    assert.deepEqual(f.log.snapshot().map(e => [e.eventType, e.severity, e.outcome]), [['system.media', 'warn', 'failed']]);
  }
});
