/** Verifies the Windows and Linux system-control adapters against fake tools: exact commands, output parsing, range validation, graceful nulls; depends on no OS features. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SystemControlUnavailable } from '../src/os-integration/system-control.js';
import { LinuxSystemControl, type SystemTool } from '../src/os-integration/system-control.linux.js';
import { WindowsSystemControl, type WindowsSystemTool } from '../src/os-integration/system-control.windows.js';

interface Call { file: string; args: string[]; input?: string }
function fakeTool(outputs: Record<string, string> = {}): { tool: SystemTool & WindowsSystemTool; calls: Call[] } {
  const calls: Call[] = [];
  const tool = async (file: string, args: string[], input?: string) => {
    calls.push({ file, args, ...(input !== undefined ? { input } : {}) });
    const key = `${file} ${args[0] ?? ''}`;
    if (key in outputs) return outputs[key]!;
    throw new SystemControlUnavailable(`${file}: not found`);
  };
  return { tool, calls };
}

test('Linux power maps to the right session commands', async () => {
  const { tool, calls } = fakeTool({ 'loginctl lock-session': '', 'systemctl suspend': '', 'systemctl reboot': '', 'systemctl poweroff': '' });
  const control = new LinuxSystemControl(tool);
  await control.power('lock'); await control.power('sleep'); await control.power('restart'); await control.power('shutdown');
  assert.deepEqual(calls.map(c => `${c.file} ${c.args.join(' ')}`),
    ['loginctl lock-session', 'systemctl suspend', 'systemctl reboot', 'systemctl poweroff']);
});

test('Linux volume parses pactl output and validates the range', async () => {
  const { tool, calls } = fakeTool({
    'pactl get-sink-volume': 'Volume: front-left: 32768 /  50% / -18.06 dB',
    'pactl get-sink-mute': 'Mute: yes',
    'pactl set-sink-volume': '', 'pactl set-sink-mute': '',
  });
  const control = new LinuxSystemControl(tool);
  assert.deepEqual(await control.getVolume(), { level: 50, muted: true });
  await control.setVolume(25, false);
  assert.deepEqual(calls.slice(-2).map(c => c.args), [['set-sink-volume', '@DEFAULT_SINK@', '25%'], ['set-sink-mute', '@DEFAULT_SINK@', '0']]);
  await assert.rejects(control.setVolume(101), SystemControlUnavailable);
  await assert.rejects(control.setVolume(-1), SystemControlUnavailable);
  await assert.rejects(control.setVolume(12.5), SystemControlUnavailable);
});

test('Linux volume rejects unparseable pactl output', async () => {
  const { tool } = fakeTool({ 'pactl get-sink-volume': 'weird output', 'pactl get-sink-mute': 'Mute: no' });
  await assert.rejects(new LinuxSystemControl(tool).getVolume(), SystemControlUnavailable);
});

test('Linux brightness is a percentage and degrades to null on any trouble', async () => {
  const { tool, calls } = fakeTool({ 'brightnessctl max': '255', 'brightnessctl get': '128', 'brightnessctl set': '' });
  const control = new LinuxSystemControl(tool);
  assert.equal(await control.getBrightness(), 50);
  await control.setBrightness(75);
  assert.deepEqual(calls.at(-1)!.args, ['set', '75%']);
  await assert.rejects(control.setBrightness(200), SystemControlUnavailable);
  const broken = new LinuxSystemControl(fakeTool({ 'brightnessctl max': '0', 'brightnessctl get': '0' }).tool);
  assert.equal(await broken.getBrightness(), null, 'a zero max means no backlight');
  const missing = new LinuxSystemControl(fakeTool().tool);
  assert.equal(await missing.getBrightness(), null, 'a missing tool means no controllable backlight');
});

test('Linux display mode reads gsettings and refuses night light', async () => {
  const { tool, calls } = fakeTool({ 'gsettings get': "'prefer-dark'", 'gsettings set': '' });
  const control = new LinuxSystemControl(tool);
  assert.deepEqual(await control.getDisplayMode(), { theme: 'dark', nightLight: null });
  await control.setDisplayMode({ theme: 'light' });
  assert.deepEqual(calls.at(-1)!.args, ['set', 'org.gnome.desktop.interface', 'color-scheme', 'default']);
  await assert.rejects(control.setDisplayMode({ nightLight: true }), SystemControlUnavailable);
  const gnomeless = new LinuxSystemControl(fakeTool().tool);
  assert.deepEqual(await gnomeless.getDisplayMode(), { theme: null, nightLight: null });
});

test('Windows power maps to the right system commands', async () => {
  const { tool, calls } = fakeTool({ 'rundll32.exe user32.dll,LockWorkStation': '', 'rundll32.exe powrprof.dll,SetSuspendState': '', 'shutdown.exe /r': '', 'shutdown.exe /s': '' });
  const control = new WindowsSystemControl(tool);
  await control.power('lock'); await control.power('sleep'); await control.power('restart'); await control.power('shutdown');
  assert.deepEqual(calls.map(c => `${c.file} ${c.args.join(' ')}`),
    ['rundll32.exe user32.dll,LockWorkStation', 'rundll32.exe powrprof.dll,SetSuspendState Sleep', 'shutdown.exe /r /t 3', 'shutdown.exe /s /t 3']);
});

test('Windows volume parses the COM script output and builds a bounded set script', async () => {
  const { tool, calls } = fakeTool({ 'powershell.exe -NoProfile': '47;True' });
  const control = new WindowsSystemControl(tool);
  assert.deepEqual(await control.getVolume(), { level: 47, muted: true });
  await control.setVolume(30, false);
  const script = calls.at(-1)!.args.at(-1)!;
  assert.match(script, /SetMasterVolumeLevelScalar\(\[float\]\(30 \/ 100\.0\)/);
  assert.match(script, /SetMute\(\$false/);
  await control.setVolume(80);
  assert.doesNotMatch(calls.at(-1)!.args.at(-1)!, /SetMute\(\$/, 'no mute call when muted is not given (the interface declaration always mentions SetMute)');
  await assert.rejects(control.setVolume(150), SystemControlUnavailable);
});

test('Windows volume rejects garbled script output', async () => {
  const { tool } = fakeTool({ 'powershell.exe -NoProfile': 'error text' });
  await assert.rejects(new WindowsSystemControl(tool).getVolume(), SystemControlUnavailable);
});

test('Windows brightness accepts only integers 0-100 and reports null otherwise', async () => {
  const { tool, calls } = fakeTool({ 'powershell.exe -NoProfile': '80' });
  const control = new WindowsSystemControl(tool);
  assert.equal(await control.getBrightness(), 80);
  await control.setBrightness(60);
  assert.match(calls.at(-1)!.args.at(-1)!, /WmiSetBrightness\(1, 60\)/);
  const blank = new WindowsSystemControl(fakeTool({ 'powershell.exe -NoProfile': '' }).tool);
  assert.equal(await blank.getBrightness(), null, 'a desktop without a WMI backlight reports null');
  await assert.rejects(control.setBrightness(-5), SystemControlUnavailable);
});

test('Windows display mode reads the registry theme and never supports night light', async () => {
  const dark = new WindowsSystemControl(fakeTool({ 'powershell.exe -NoProfile': '0' }).tool);
  assert.deepEqual(await dark.getDisplayMode(), { theme: 'dark', nightLight: null });
  const light = new WindowsSystemControl(fakeTool({ 'powershell.exe -NoProfile': '1' }).tool);
  assert.deepEqual(await light.getDisplayMode(), { theme: 'light', nightLight: null });
  const other = new WindowsSystemControl(fakeTool({ 'powershell.exe -NoProfile': 'garbage' }).tool);
  assert.deepEqual(await other.getDisplayMode(), { theme: null, nightLight: null });
  const { tool, calls } = fakeTool({ 'powershell.exe -NoProfile': '' });
  const control = new WindowsSystemControl(tool);
  await control.setDisplayMode({ theme: 'dark' });
  const script = calls.at(-1)!.args.at(-1)!;
  assert.match(script, /AppsUseLightTheme -Value 0/);
  assert.match(script, /SystemUsesLightTheme -Value 0/);
  await assert.rejects(control.setDisplayMode({ nightLight: false }), SystemControlUnavailable);
});

test('a missing tool surfaces as SystemControlUnavailable, never a raw spawn error', async () => {
  const { tool } = fakeTool();
  await assert.rejects(new LinuxSystemControl(tool).getVolume(), SystemControlUnavailable);
  await assert.rejects(new WindowsSystemControl(tool).power('lock'), SystemControlUnavailable);
});

test('Windows volume read clamps over-range output, rejects 4-digit output and reads mute False', async () => {
  const read = (out: string) => new WindowsSystemControl(fakeTool({ 'powershell.exe -NoProfile': out }).tool).getVolume();
  assert.deepEqual(await read('150;False'), { level: 100, muted: false });
  assert.deepEqual(await read('0;False'), { level: 0, muted: false });
  await assert.rejects(read('1000;True'), SystemControlUnavailable);
  await assert.rejects(read('-5;True'), SystemControlUnavailable);
  await assert.rejects(read('50;maybe'), SystemControlUnavailable);
});

test('Windows volume and brightness writes refuse fractions, negatives and over-range without running a script', async () => {
  const { tool, calls } = fakeTool({ 'powershell.exe -NoProfile': '' });
  const control = new WindowsSystemControl(tool);
  for (const bad of [1.5, -1, 101, Number.NaN]) {
    await assert.rejects(control.setVolume(bad), SystemControlUnavailable);
    await assert.rejects(control.setBrightness(bad), SystemControlUnavailable);
  }
  assert.equal(calls.length, 0);
  await control.setVolume(0); await control.setVolume(100); await control.setBrightness(0); await control.setBrightness(100);
  assert.equal(calls.length, 4, 'both edges are valid');
  assert.deepEqual(calls[0]!.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'], 'the worker can never wait on a prompt');
});

test('Windows brightness read rejects fractional, negative and over-range answers as null, and keeps both edges', async () => {
  const read = (out: string) => new WindowsSystemControl(fakeTool({ 'powershell.exe -NoProfile': out }).tool).getBrightness();
  assert.equal(await read('0'), 0);
  assert.equal(await read('100'), 100);
  assert.equal(await read('55.5'), null);
  assert.equal(await read('-1'), null);
  assert.equal(await read('101'), null);
});
