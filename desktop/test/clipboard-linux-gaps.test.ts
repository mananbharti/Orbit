/** Tests Linux clipboard adapter edges and tool bridge process handling with synthetic tools; never accesses the user's clipboard. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { LinuxClipboard, runClipboardTool, type ToolResult } from '../src/os-integration/clipboard.linux.js';
import { MAX_CLIPBOARD_BYTES } from '../src/protocol/clipboard.js';

const result = (text: string, code = 0, error = '', overflow = false): ToolResult => ({ output: Buffer.from(text), code, error, overflow });
const wayland = { WAYLAND_DISPLAY: 'wayland-0' };

test('a disposed adapter refuses reads and writes, including a dispose between the format and content reads', async () => {
  let calls = 0;
  const adapter = new LinuxClipboard(wayland, async () => { calls++; return result('text/plain'); });
  await adapter.dispose();
  await assert.rejects(adapter.read(), /Clipboard unavailable/);
  await assert.rejects(adapter.write('x'), /Clipboard unavailable/);
  assert.equal(calls, 0);
  let runs = 0;
  const racing = new LinuxClipboard(wayland, async () => { runs++; await racing.dispose(); return result('text/plain'); });
  await assert.rejects(racing.read(), /Clipboard unavailable/);
  assert.equal(runs, 1);
});

test('write rejects unrepresentable text before running a tool and tool failure after it', async () => {
  let calls = 0;
  const adapter = new LinuxClipboard(wayland, async () => { calls++; return result('', 1); });
  await assert.rejects(adapter.write('a'.repeat(MAX_CLIPBOARD_BYTES + 1)), /Clipboard unavailable/);
  assert.equal(calls, 0);
  await assert.rejects(adapter.write('ok'), /Clipboard unavailable/);
  assert.equal(calls, 1);
});

test('only an exit code of 1 with a known empty-clipboard message is an empty clipboard; everything else is unavailable', async () => {
  const read = (code: number, error: string, overflow = false) =>
    new LinuxClipboard({ DISPLAY: ':0' }, async () => result('', code, error, overflow)).read();
  for (const message of ['Nothing is copied', 'No selection', 'target TARGETS not available']) {
    assert.deepEqual(await read(1, message), { kind: 'unsupported' });
    await assert.rejects(read(2, message), /Clipboard unavailable/);
    await assert.rejects(read(0, message, true), /Clipboard unavailable/);
  }
  await assert.rejects(read(1, 'some other failure'), /Clipboard unavailable/);
  await assert.rejects(read(0, '', true), /Clipboard unavailable/);
});

test('format lists with CRLF endings and padding still select the plain text target', async () => {
  const run = async (_file: string, args: string[]) => args.includes('--list-types') ? result(' text/plain \r\ntext/x-other\r\n') : result('hello');
  assert.deepEqual(await new LinuxClipboard(wayland, run).read(), { kind: 'text', text: 'hello' });
  const richPadded = async (_file: string, args: string[]) => args.includes('--list-types') ? result('text/plain\r\n image/png \r\n') : result('hello');
  assert.deepEqual(await new LinuxClipboard(wayland, richPadded).read(), { kind: 'unsupported' });
});

test('tool bridge keeps stderr bounded, stops collecting after overflow and kills the tool', async () => {
  const noisy = await runClipboardTool(process.execPath, ['-e', 'process.stderr.write("e".repeat(60000)); setTimeout(() => {}, 50)'], 100);
  assert.ok(noisy.error.length > 0 && noisy.error.length <= 16 * 1024);
  const script = 'process.stdout.write("a".repeat(100)); setTimeout(() => process.stdout.write("b".repeat(100)), 150); setTimeout(() => process.stdout.write("c"), 300); setTimeout(() => {}, 1500)';
  const overflow = await runClipboardTool(process.execPath, ['-e', script], 150);
  assert.equal(overflow.overflow, true);
  assert.equal(overflow.output.length, 100);
  assert.equal(overflow.code, null);
});

test('a writer ignores tool output and resolves on exit even when a forked owner keeps stderr open', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, async () => {
  const started = Date.now();
  const written = await runClipboardTool('sh', ['-c', 'cat > /dev/null; echo leaked; sleep 5 & exit 0'], 0, 'payload');
  assert.equal(written.code, 0);
  assert.equal(written.output.length, 0);
  assert.ok(Date.now() - started < 3_000);
});

test('a hung tool is killed and rejected at the timeout', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'orbit-clip-')), 'pid');
  await assert.rejects(runClipboardTool('sh', ['-c', `echo $$ > "${pidFile}"; exec sleep 20`], 100), /Clipboard unavailable/);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  await sleep(200);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('a writer that closes stdin early is reported unavailable instead of crashing', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, async () => {
  await assert.rejects(runClipboardTool('sh', ['-c', 'exec 0<&-; sleep 1'], 0, 'x'.repeat(2_000_000)), /Clipboard unavailable/);
});
