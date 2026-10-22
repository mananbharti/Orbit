/** Verifies the per-app audio mixers against fake pactl/PowerShell: JSON and line parsing, pid-to-index resolution, validation, graceful failures; depends on no audio devices. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioMixerUnavailable } from '../src/os-integration/audio-mixer.js';
import { LinuxAudioMixer } from '../src/os-integration/audio-mixer.linux.js';
import { WindowsAudioMixer } from '../src/os-integration/audio-mixer.windows.js';

const SINK_INPUTS = JSON.stringify([
  { index: 12, volume: { 'front-left': { value_percent: '47%' }, 'front-right': { value_percent: '47%' } }, mute: true,
    properties: { 'application.process.id': '3210', 'application.name': 'Spotify' } },
  { index: 13, volume: { 'front-left': { value_percent: '130%' } }, mute: false,
    properties: { 'application.process.id': '4411', 'application.name': 'Firefox' } },
  { index: 14, volume: {}, mute: false, properties: { 'application.name': 'NoPid' } },
]);

test('Linux listSessions parses pactl JSON, skips pid-less entries and caps volume', async () => {
  const mixer = new LinuxAudioMixer(async () => SINK_INPUTS);
  assert.deepEqual(await mixer.listSessions(), [
    { id: '3210', name: 'Spotify', volume: 47, muted: true },
    { id: '4411', name: 'Firefox', volume: 100, muted: false },
  ]);
});

test('Linux listSessions rejects garbled pactl output', async () => {
  await assert.rejects(new LinuxAudioMixer(async () => 'not json').listSessions(), AudioMixerUnavailable);
  await assert.rejects(new LinuxAudioMixer(async () => { throw new AudioMixerUnavailable('pactl is unavailable'); }).listSessions(), AudioMixerUnavailable);
});

test('Linux setSession validates the id and resolves the sink-input index by pid', async () => {
  const calls: string[][] = [];
  const mixer = new LinuxAudioMixer(async args => { calls.push(args); return SINK_INPUTS; });
  await assert.rejects(mixer.setSession('12; rm -rf /', 50), AudioMixerUnavailable);
  await assert.rejects(mixer.setSession('9999', 50), /no longer playing audio/);
  assert.equal(calls.filter(args => args[0] === 'set-sink-input-volume').length, 0, 'nothing was set for an invalid or unknown id');
  await mixer.setSession('4411', 30, true);
  assert.deepEqual(calls.slice(-2), [['set-sink-input-volume', '13', '30%'], ['set-sink-input-mute', '13', '1']]);
  await assert.rejects(mixer.setSession('4411', 101), AudioMixerUnavailable);
  await assert.rejects(mixer.setSession('4411', 10.5), AudioMixerUnavailable);
});

test('Windows listSessions parses mixer lines and skips malformed ones', async () => {
  const mixer = new WindowsAudioMixer(async () => '3210|Spotify|47|True\n4411|Firefox|130|False\nbroken line\n12||10|False');
  assert.deepEqual(await mixer.listSessions(), [
    { id: '3210', name: 'Spotify', volume: 47, muted: true },
    { id: '4411', name: 'Firefox', volume: 100, muted: false },
  ]);
  assert.deepEqual(await new WindowsAudioMixer(async () => '').listSessions(), [], 'no sessions reads as an empty list');
});

test('Windows setSession builds typed literals and treats "gone" as unavailable', async () => {
  const scripts: string[] = [];
  const mixer = new WindowsAudioMixer(async script => { scripts.push(script); return 'ok'; });
  await assert.rejects(mixer.setSession('abc', 50), AudioMixerUnavailable);
  assert.equal(scripts.length, 0, 'no PowerShell runs for an invalid id');
  await mixer.setSession('3210', 45, true);
  const script = scripts.at(-1)!;
  assert.match(script, /\[uint32\]3210/);
  assert.match(script, /\[float\]45/);
  assert.match(script, /\[bool\]\$True, \[bool\]\$true, \[bool\]\$true/);
  await mixer.setSession('3210');
  assert.match(scripts.at(-1)!, /\[bool\]\$False, \[bool\]\$false, \[bool\]\$false/);
  await assert.rejects(mixer.setSession('3210', -1), AudioMixerUnavailable);
  const gone = new WindowsAudioMixer(async () => 'gone');
  await assert.rejects(gone.setSession('3210', 50), /no longer playing audio/);
});

test('Windows listSessions enforces field widths: long pids, long names and 4-digit volumes are dropped', async () => {
  const mixer = new WindowsAudioMixer(async () => ['12345678901|PidTooLong|10|True', `7|${'n'.repeat(129)}|10|True`, `8|${'n'.repeat(128)}|10|True`, '9|Loud|1000|True', '10|Fine|0|False'].join('\n'));
  const sessions = await mixer.listSessions();
  assert.deepEqual(sessions.map(s => s.id), ['8', '10']);
  assert.equal(sessions[0]!.name.length, 128);
  assert.deepEqual(sessions[1], { id: '10', name: 'Fine', volume: 0, muted: false });
});

test('Windows setSession refuses 11-digit ids and bad levels without running a script, and accepts both edges', async () => {
  const scripts: string[] = [];
  const mixer = new WindowsAudioMixer(async script => { scripts.push(script); return 'ok'; });
  await assert.rejects(mixer.setSession('12345678901', 10), AudioMixerUnavailable);
  for (const bad of [150, 101, -1, 10.5]) await assert.rejects(mixer.setSession('5', bad), /Volume must be 0-100/);
  assert.equal(scripts.length, 0);
  await mixer.setSession('5', 0); await mixer.setSession('5', 100);
  assert.equal(scripts.length, 2);
});

test('Linux listSessions treats non-array JSON as no sessions and skips unusable entries', async () => {
  assert.deepEqual(await new LinuxAudioMixer(async () => '{}').listSessions(), []);
  const odd = JSON.stringify([
    { index: 1, volume: {}, mute: false, properties: { 'application.process.id': '0', 'application.name': 'ZeroPid' } },
    { index: 2, volume: {}, mute: false, properties: { 'application.process.id': 'abc', 'application.name': 'BadPid' } },
    { volume: {}, mute: false, properties: { 'application.process.id': '55', 'application.name': 'NoIndex' } },
    { index: 3, volume: {}, mute: false, properties: { 'application.process.id': '66' } },
    { index: 4, volume: {}, mute: false, properties: { 'application.process.id': '77', 'application.name': 'L'.repeat(200) } },
  ]);
  const sessions = await new LinuxAudioMixer(async () => odd).listSessions();
  assert.deepEqual(sessions.map(s => s.id), ['66', '77']);
  assert.equal(sessions[0]!.name, 'Unknown');
  assert.equal(sessions[1]!.name.length, 128);
});

test('Linux setSession rejects malformed ids by name, refuses -1, and only touches what was asked', async () => {
  const calls: string[][] = [];
  const mixer = new LinuxAudioMixer(async args => { calls.push(args); return SINK_INPUTS; });
  await assert.rejects(mixer.setSession('12345678901', 5), /Invalid session id/);
  assert.equal(calls.length, 0, 'pactl is not even consulted for a malformed id');
  await assert.rejects(mixer.setSession('4411', -1), /Volume must be 0-100/);
  assert.ok(!calls.some(args => args[0] === 'set-sink-input-volume'));
  calls.length = 0;
  await mixer.setSession('4411', 30);
  assert.ok(!calls.some(args => args[0] === 'set-sink-input-mute'), 'no mute call when muted is not given');
  await mixer.setSession('4411', undefined, false);
  assert.deepEqual(calls.at(-1), ['set-sink-input-mute', '13', '0']);
  assert.ok(!calls.slice(calls.length - 3).some(args => args[0] === 'set-sink-input-volume' && args[2] === 'undefined%'));
});
