/** Tests native adapter boundaries with synthetic registrations and helper processes; depends on temporary files; never activates installed applications. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { desktopEntry, LinuxAppLauncher } from '../src/os-integration/app-launcher.linux.js';
import { WindowsAppLauncher } from '../src/os-integration/app-launcher.windows.js';
import { runLauncherTool, type LauncherTool } from '../src/os-integration/launcher-tool.js';
import { ProtocolError } from '../src/protocol/errors.js';

const text = '[Desktop Entry]\nType=Application\nName=Base App\nExec=synthetic-app\n';
test('desktop entries respect visibility, type, localization, duplicate keys and terminal requirements', () => {
  const env = { LANG: 'sr_RS.UTF-8@latin', XDG_CURRENT_DESKTOP: 'GNOME:Unity' };
  assert.equal(desktopEntry(`${text}Name[sr@latin]=Localized\\sApp\n`, env)?.name, 'Localized App');
  for (const extra of ['Hidden=true', 'NoDisplay=true', 'Terminal=true', 'OnlyShowIn=KDE;', 'NotShowIn=GNOME;', 'Terminal=invalid', 'Name=Duplicate']) {
    assert.equal(desktopEntry(`${text}${extra}\n`, env), undefined);
  }
  assert.ok(desktopEntry(`${text}OnlyShowIn=Unity;\n`, env));
  assert.equal(desktopEntry(text.replace('Type=Application', 'Type=Link'), env), undefined);
  assert.equal(desktopEntry(text.replace('Exec=synthetic-app', ''), env), undefined);
});

test('XDG precedence masks hidden entries; activation passes an exact selected path to gio and checks changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-launcher-xdg-'));
  const user = join(root, 'user'); const system = join(root, 'system');
  mkdirSync(join(user, 'applications'), { recursive: true }); mkdirSync(join(system, 'applications'), { recursive: true });
  const calls: { file: string; args: string[] }[] = [];
  const run: LauncherTool = async (file, args) => { calls.push({ file, args }); return ''; };
  const signal = new AbortController().signal;
  try {
    writeFileSync(join(system, 'applications', 'masked.desktop'), text);
    writeFileSync(join(user, 'applications', 'masked.desktop'), `${text}Hidden=true\n`);
    const selected = join(user, 'applications', 'quotes $(never-execute).desktop'); writeFileSync(selected, text);
    writeFileSync(join(user, 'applications', 'missing.desktop'), `${text}TryExec=orbit-nonexistent-tool\n`);
    const adapter = new LinuxAppLauncher({ XDG_DATA_HOME: user, XDG_DATA_DIRS: system, DISPLAY: ':0' }, run);
    const apps = await adapter.list(signal); assert.equal(apps.length, 1);
    let checked = false;
    await adapter.launch(apps[0]!, () => { checked = true; }, signal);
    assert.equal(checked, true);
    assert.deepEqual(calls.at(-1), { file: 'gio', args: ['launch', selected] });
    writeFileSync(selected, text.replace('synthetic-app', 'changed-app'));
    await assert.rejects(adapter.launch(apps[0]!, () => {}, signal), /LAUNCHER_STALE_CATALOG/);
    assert.equal(calls.filter(call => call.args[0] === 'launch').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing display/tool and revoked pre-launch authorization fail without fallback', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(new LinuxAppLauncher({}).list(signal), /LAUNCHER_UNAVAILABLE/);
  let calls = 0;
  const run: LauncherTool = async () => { calls++; throw new ProtocolError('LAUNCHER_UNAVAILABLE'); };
  await assert.rejects(new LinuxAppLauncher({ DISPLAY: ':0' }, run).list(signal), /LAUNCHER_UNAVAILABLE/);
  assert.equal(calls, 1);
});

test('Windows registration data travels over stdin and is never interpolated into the PowerShell script', async () => {
  const app = { key: "id'; Write-Output 'untrusted", name: 'Synthetic', revision: 'a'.repeat(64) };
  const run: LauncherTool = async (_file, args, options) => {
    assert.equal(args.includes('-STA'), true);
    assert.equal(args.at(-1)!.includes(app.key), false);
    const input = JSON.parse(options.input!);
    if (input.action === 'list') return JSON.stringify([app]);
    assert.equal(input.key, app.key);
    options.authorize!(); return '';
  };
  const adapter = new WindowsAppLauncher(run); const signal = new AbortController().signal;
  assert.deepEqual(await adapter.list(signal), [app]);
  await assert.rejects(adapter.launch(app, () => { throw new ProtocolError('UNAUTHENTICATED'); }, signal), /UNAUTHENTICATED/);
});

test('native helper waits for authorization and redacts failures and excess output', async () => {
  const signal = new AbortController().signal;
  const script = "process.stdin.once('data',()=>{process.stdout.write('READY\\n');process.stdin.once('data',b=>{process.exit(b.toString().trim()==='GO'?0:1)})})";
  let checked = false;
  await runLauncherTool(process.execPath, ['-e', script], { signal, input: '{}', activation: true, authorize: () => { checked = true; } });
  assert.equal(checked, true);
  await assert.rejects(runLauncherTool(process.execPath, ['-e', script], { signal, input: '{}', activation: true,
    authorize: () => { throw new ProtocolError('UNAUTHENTICATED'); } }), /UNAUTHENTICATED/);
  await assert.rejects(runLauncherTool(process.execPath, ['-e', "process.stderr.write('private diagnostics');process.exit(1)"], { signal }), /LAUNCHER_UNAVAILABLE/);
  await assert.rejects(runLauncherTool(process.execPath, ['-e', "process.stdout.write('x'.repeat(3*1024*1024))"], { signal }), /LAUNCHER_LIMIT/);
});

test('launcher helper exit codes and signals map to the right protocol errors', async () => {
  const signal = new AbortController().signal;
  const node = (code: string) => [process.execPath, ['-e', code]] as const;
  const [file, args] = node("process.stdin.on('data',()=>{});process.stdin.once('data',()=>process.exit(3))");
  await assert.rejects(runLauncherTool(file, [...args], { signal, input: '{}', activation: true, authorize: () => {} }), /LAUNCHER_STALE_CATALOG/);
  const [f2, a2] = node("process.exit(0)");
  await assert.rejects(runLauncherTool(f2, [...a2], { signal, input: '{}', activation: true, authorize: () => {} }), /LAUNCHER_UNKNOWN_OUTCOME/, 'exiting 0 without ever asking for authorization is not a success');
  const [f3, a3] = node("process.exit(1)");
  await assert.rejects(runLauncherTool(f3, [...a3], { signal, input: '{}', activation: true }), /LAUNCHER_UNKNOWN_OUTCOME/);
  await assert.rejects(runLauncherTool(f3, [...a3], { signal }), /LAUNCHER_UNAVAILABLE/);
  await assert.rejects(runLauncherTool('orbit-no-such-binary-xyz', [], { signal }), /LAUNCHER_UNAVAILABLE/);
  const gone = new AbortController(); gone.abort();
  await assert.rejects(runLauncherTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: gone.signal }), /UNAUTHENTICATED/);
});

test('launcher helper returns stdout, receives its input, and stops when the signal aborts mid-run', async () => {
  const signal = new AbortController().signal;
  const echo = "let s='';process.stdin.on('data',d=>{s+=d});process.stdin.on('end',()=>{process.stdout.write(s.trim().toUpperCase())})";
  assert.equal(await runLauncherTool(process.execPath, ['-e', echo], { signal, input: 'hello' }), 'HELLO');
  const control = new AbortController();
  const running = runLauncherTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: control.signal });
  setTimeout(() => control.abort(), 50);
  await assert.rejects(running, /UNAUTHENTICATED/);
});

test('Windows icons are returned only when they look like bounded base64 PNG data', async () => {
  const signal = new AbortController().signal;
  const icon = async (out: string, target: string | null = 'C:\\app.exe') => new WindowsAppLauncher(async () => out).icon({ key: 'k', name: 'n', revision: 'r', ...(target ? { target } : {}) }, signal);
  assert.equal(await icon('  iVBORw0KGgo=\n'), 'iVBORw0KGgo=', 'trimmed');
  assert.equal(await icon('iVBORw0KGgo=', null), null, 'no target means no icon');
  assert.equal(await icon('null'), null);
  assert.equal(await icon(''), null);
  assert.equal(await icon('<script>alert(1)</script>'), null);
  assert.equal(await icon('A'.repeat(90_000)), 'A'.repeat(90_000), 'the limit itself is allowed');
  assert.equal(await icon('A'.repeat(90_001)), null);
  let ran = false;
  await new WindowsAppLauncher(async () => { ran = true; return ''; }).icon({ key: 'k', name: 'n', revision: 'r' }, signal);
  assert.equal(ran, false, 'no PowerShell without a discovered target');
});

test('Windows list rejects a catalog that breaks the entry schema', async () => {
  const signal = new AbortController().signal;
  const list = (value: unknown) => new WindowsAppLauncher(async () => JSON.stringify(value)).list(signal);
  const good = { key: 'k', name: 'App', revision: 'a'.repeat(64) };
  assert.deepEqual(await list([good]), [good]);
  await assert.rejects(list([{ ...good, revision: 'short' }]));
  await assert.rejects(list([{ ...good, key: '' }]));
  await assert.rejects(list([{ ...good, extra: 'field' }]));
  await assert.rejects(list(Array.from({ length: 2049 }, (_, i) => ({ ...good, key: `k${i}` }))));
});

test('an aborted helper is killed, not left running', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-launcher-kill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  const control = new AbortController();
  const running = runLauncherTool(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`], { signal: control.signal });
  let pid = 0;
  for (let i = 0; i < 200 && !pid; i++) { try { pid = Number(readFileSync(pidFile, 'utf8')); } catch { await new Promise(r => setTimeout(r, 25)); } }
  assert.ok(pid > 0, 'helper started');
  control.abort();
  await assert.rejects(running, /UNAUTHENTICATED/);
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 25)); } catch { alive = false; } }
  assert.equal(alive, false, 'the helper process is gone');
});

test('an activation finishes when the helper exits even if an app it started still holds the output pipe', async () => {
  const signal = new AbortController().signal;
  const script = `const {spawn}=require('child_process');process.stdin.once('data',()=>{process.stdout.write('READY\\n');process.stdin.once('data',()=>{
    spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{detached:true,stdio:['ignore','inherit','ignore']}).unref();process.exit(0)})})`;
  const started = Date.now();
  await runLauncherTool(process.execPath, ['-e', script], { signal, input: '{}', activation: true, authorize: () => {} });
  assert.ok(Date.now() - started < 2_500, `finished at helper exit, not when the launched app released the pipe (${Date.now() - started}ms)`);
});
