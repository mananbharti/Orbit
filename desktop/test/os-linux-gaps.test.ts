/** Verifies Linux system-control and audio-mixer edges against fake tools: caps, rounding, non-finite reads, validation before any command, catalog races; depends on no OS features. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioMixerUnavailable } from '../src/os-integration/audio-mixer.js';
import { LinuxAudioMixer } from '../src/os-integration/audio-mixer.linux.js';
import { SystemControlUnavailable } from '../src/os-integration/system-control.js';
import { LinuxSystemControl } from '../src/os-integration/system-control.linux.js';

function control(outputs: Record<string, string>) {
  const calls: string[] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args].join(' '));
    const key = `${file} ${args[0] ?? ''}`;
    if (key in outputs) return outputs[key]!;
    throw new SystemControlUnavailable('missing');
  };
  return { control: new LinuxSystemControl(run), calls };
}

test('volume above 100 percent is reported as 100 and muted only on an exact yes', async () => {
  const { control: c } = control({ 'pactl get-sink-volume': 'Volume: front-left: 70000 / 107% / 1.9 dB', 'pactl get-sink-mute': 'Mute: no' });
  assert.deepEqual(await c.getVolume(), { level: 100, muted: false });
});

test('brightness rounds to the nearest percent and a non-numeric reading is unknown', async () => {
  assert.equal(await control({ 'brightnessctl max': '3', 'brightnessctl get': '2' }).control.getBrightness(), 67);
  assert.equal(await control({ 'brightnessctl max': '3', 'brightnessctl get': '1' }).control.getBrightness(), 33);
  assert.equal(await control({ 'brightnessctl max': '100', 'brightnessctl get': 'n/a' }).control.getBrightness(), null);
});

test('out-of-range brightness and display requests are refused before any command runs', async () => {
  const { control: c, calls } = control({});
  for (const level of [-1, 101, 1.5, Number.NaN]) {
    await assert.rejects(c.setBrightness(level), SystemControlUnavailable);
    await assert.rejects(c.setVolume(level), SystemControlUnavailable);
  }
  assert.deepEqual(calls, []);
  await assert.rejects(c.setDisplayMode({ nightLight: true }), /Night light is not supported/);
  await assert.rejects(c.setDisplayMode({ nightLight: false }), /Night light is not supported/);
  assert.deepEqual(calls, []);
  await assert.rejects(c.setDisplayMode({ theme: 'dark', nightLight: true }), /Night light/);
  assert.deepEqual(calls, []);
  const ok = control({ 'gsettings set': '' });
  await ok.control.setDisplayMode({});
  assert.deepEqual(ok.calls, []);
  await ok.control.setDisplayMode({ theme: 'light' });
  assert.deepEqual(ok.calls, ['gsettings set org.gnome.desktop.interface color-scheme default']);
});

const input = (index: unknown, pid: string, extra: Record<string, unknown> = {}) =>
  ({ index, volume: { left: { value_percent: '20%' } }, mute: false, properties: { 'application.process.id': pid, 'application.name': 'App' }, ...extra });

test('only a real boolean true counts as muted', async () => {
  const [session] = await new LinuxAudioMixer(async () => JSON.stringify([input(1, '10', { mute: 1 })])).listSessions();
  assert.equal(session?.muted, false);
});

test('a session that vanishes between validation and resolution never gets a command', async () => {
  const sent: string[][] = [];
  let lists = 0;
  const mixer = new LinuxAudioMixer(async args => {
    if (args[0] === '-f') { lists++; return JSON.stringify(lists === 1 ? [input(5, '10')] : []); }
    sent.push(args); return '';
  });
  await assert.rejects(mixer.setSession('10', 50), /no longer playing/);
  const broken = new LinuxAudioMixer(async args => {
    if (args[0] === '-f') { lists++; return JSON.stringify(lists % 2 ? [input(5, '10')] : [input(undefined, '10')]); }
    sent.push(args); return '';
  });
  lists = 0;
  await assert.rejects(broken.setSession('10', 50), /no longer playing/);
  const unknown = new LinuxAudioMixer(async args => { if (args[0] === '-f') return JSON.stringify([input(5, '10')]); sent.push(args); return ''; });
  await assert.rejects(unknown.setSession('99', 50), AudioMixerUnavailable);
  assert.deepEqual(sent, []);
});

test('Windows refuses night light before changing the theme', async () => {
  const { WindowsSystemControl } = await import('../src/os-integration/system-control.windows.js');
  const scripts: string[] = [];
  const windows = new WindowsSystemControl(async script => { scripts.push(script); return ''; });
  await assert.rejects(windows.setDisplayMode({ theme: 'dark', nightLight: true }), /Night light/);
  await assert.rejects(windows.setDisplayMode({ nightLight: false }), /Night light/);
  assert.deepEqual(scripts, []);
  await windows.setDisplayMode({ theme: 'dark' });
  assert.equal(scripts.length, 1);
});
