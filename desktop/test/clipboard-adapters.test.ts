/** Tests clipboard format and process boundaries with synthetic data; depends on injected Linux tools; never accesses the user's clipboard. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinuxClipboard, runClipboardTool, type ClipboardTool, type ToolResult } from '../src/os-integration/clipboard.linux.js';
import { clipboardTextSchema, MAX_CLIPBOARD_BYTES } from '../src/protocol/clipboard.js';

const result = (text: string, code = 0): ToolResult => ({ output: Buffer.from(text), code, error: '', overflow: false });

test('clipboard accepts exact UTF-8 limit, empty text and Unicode, rejects excess and native-unrepresentable text', () => {
  for (const text of ['', 'line\n\t雪😀\r\n', '😀'.repeat(MAX_CLIPBOARD_BYTES / 4)]) assert.equal(clipboardTextSchema.safeParse(text).success, true);
  for (const text of ['😀'.repeat(MAX_CLIPBOARD_BYTES / 4) + 'a', '\ud800', 'a\0b']) assert.equal(clipboardTextSchema.safeParse(text).success, false);
});

for (const wayland of [true, false]) {
  const environment = wayland ? { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } : { DISPLAY: ':0' };
  test(`${wayland ? 'Wayland' : 'X11'} preserves text and uses explicit targets, selection and stdin`, async () => {
    const calls: { file: string; args: string[]; input?: string }[] = [];
    const text = '\uFEFF雪😀\n\t\"$(secret); --help\r\n';
    const run: ClipboardTool = async (file, args, _limit, input) => {
      calls.push({ file, args, input });
      if (input !== undefined) return result('');
      return result(args.includes('--list-types') || args.includes('TARGETS')
        ? wayland ? 'text/plain;charset=utf-8\n' : 'TARGETS\nUTF8_STRING\n' : text);
    };
    const adapter = new LinuxClipboard(environment, run);
    assert.deepEqual(await adapter.read(), { kind: 'text', text });
    await adapter.write(text);
    assert.equal(calls[2]?.input, text);
    assert.ok(calls.every(call => !call.args.includes(text)));
    if (wayland) {
      assert.deepEqual(calls.map(call => call.file), ['wl-paste', 'wl-paste', 'wl-copy']);
      assert.ok(calls[1]?.args.includes('--no-newline'));
    } else {
      assert.ok(calls.every(call => call.file === 'xclip' && call.args.includes('clipboard')));
    }
    await adapter.dispose();
    await assert.rejects(adapter.read(), /Clipboard unavailable/);
  });
}

test('unsupported, rich, file and image formats do not cause content reads', async () => {
  for (const types of ['image/png', 'text/html\ntext/plain', 'text/uri-list\ntext/plain', 'application/rtf', 'TARGETS']) {
    let reads = 0;
    const adapter = new LinuxClipboard({ WAYLAND_DISPLAY: 'wayland-0' }, async () => { reads++; return result(types); });
    assert.deepEqual(await adapter.read(), { kind: 'unsupported' });
    assert.equal(reads, 1);
  }
});

test('oversized and invalid UTF-8 content are ignored and never returned', async () => {
  for (const value of [{ ...result('sensitive'), overflow: true }, { ...result(''), output: Buffer.from([0xff]) }]) {
    const adapter = new LinuxClipboard({ DISPLAY: ':0' }, async (_file, args) => args.includes('TARGETS') ? result('UTF8_STRING') : value);
    assert.deepEqual(await adapter.read(), { kind: value.overflow ? 'oversized' : 'unsupported' });
  }
});

test('empty clipboard differs from missing tools/display access; failures never switch backends or expose stderr', async () => {
  assert.throws(() => new LinuxClipboard({}), /Clipboard unavailable/);
  assert.throws(() => new LinuxClipboard({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }), /Clipboard unavailable/);
  const calls: string[] = [];
  const adapter = new LinuxClipboard({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, async file => {
    calls.push(file); return { ...result('', 1), error: 'secret diagnostic' };
  });
  await assert.rejects(adapter.read(), error => error instanceof Error && !error.message.includes('secret'));
  assert.deepEqual(calls, ['wl-paste']);
  const empty = new LinuxClipboard({ DISPLAY: ':0' }, async () => ({ ...result('', 1), error: 'Error: target TARGETS not available' }));
  assert.deepEqual(await empty.read(), { kind: 'unsupported' });
});

test('tool bridge bounds output, reports process failures and rejects unavailable executables without diagnostics', async () => {
  const overflow = await runClipboardTool(process.execPath, ['-e', 'process.stdout.write("a".repeat(8193))'], MAX_CLIPBOARD_BYTES);
  assert.equal(overflow.overflow, true);
  assert.ok(overflow.output.length <= MAX_CLIPBOARD_BYTES);
  const failure = await runClipboardTool(process.execPath, ['-e', 'process.exit(2)'], MAX_CLIPBOARD_BYTES);
  assert.equal(failure.code, 2);
  await assert.rejects(runClipboardTool('orbit-nonexistent-clipboard-test-tool', [], 0), /Clipboard unavailable/);
});
