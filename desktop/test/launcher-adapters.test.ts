/** Tests native adapter boundaries with synthetic registrations and helper processes; depends on temporary files; never activates installed applications. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
