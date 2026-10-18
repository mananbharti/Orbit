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
