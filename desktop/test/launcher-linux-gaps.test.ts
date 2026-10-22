/** Tests Linux desktop-entry parsing and catalog scanning limits on synthetic temp trees; never launches or reads real applications. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { desktopEntry, LinuxAppLauncher } from '../src/os-integration/app-launcher.linux.js';
import type { LauncherTool } from '../src/os-integration/launcher-tool.js';

const entry = (name = 'Synthetic', extra = '') => `[Desktop Entry]\nType=Application\nName=${name}\nExec=synthetic-app\n${extra}`;
const run: LauncherTool = async () => '';
const posix = { skip: process.platform === 'win32' && 'needs POSIX file modes' };

function tree(body: (apps: string, root: string) => void | Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'orbit-launcher-gap-'));
    const apps = join(root, 'data', 'applications');
    mkdirSync(apps, { recursive: true });
    try { await body(apps, root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}
const list = (root: string, env: NodeJS.ProcessEnv = {}) =>
  new LinuxAppLauncher({ XDG_DATA_HOME: join(root, 'data'), XDG_DATA_DIRS: join(root, 'none'), DISPLAY: ':0', ...env }, run).list(new AbortController().signal);

test('desktop entry parsing ignores comments, rejects repeated groups and nameless entries, and picks the most specific locale', () => {
  assert.equal(desktopEntry(`${entry()}# comment line\n`, {})?.name, 'Synthetic');
  assert.equal(desktopEntry(`${entry()}[Desktop Entry]\n`, {}), undefined);
  assert.equal(desktopEntry(`${entry()}[Other]\nKey=1\n[Other]\nKey=2\n`, {}), undefined);
  assert.equal(desktopEntry(entry('').replace('Name=\n', 'Name=\n'), {}), undefined);
  assert.equal(desktopEntry('[Desktop Entry]\nType=Application\nExec=synthetic-app\n', {}), undefined);
  assert.equal(desktopEntry(`${entry()}Name[de]=Deutsch\n`, { LANG: 'de_DE.UTF-8' })?.name, 'Deutsch');
  assert.equal(desktopEntry(`${entry()}Name[de]=Deutsch\nName[de_DE]=Deutschland\n`, { LANG: 'de_DE.UTF-8' })?.name, 'Deutschland');
  assert.equal(desktopEntry(`${entry()}Name[sr_RS]=Region\n`, { LANG: 'sr_RS@latin' })?.name, 'Region');
  assert.equal(desktopEntry(`${entry()}Name[de]=Deutsch\n`, { LANG: 'fr_FR.UTF-8' })?.name, 'Synthetic');
});

test('TryExec must be an executable regular file reached by an absolute path or an absolute PATH directory', posix, tree(async (apps, root) => {
  const bin = join(root, 'bin'); mkdirSync(bin);
  const good = join(bin, 'good-tool'); writeFileSync(good, '#!/bin/sh\n'); chmodSync(good, 0o755);
  const plain = join(bin, 'plain-tool'); writeFileSync(plain, 'x'); chmodSync(plain, 0o644);
  mkdirSync(join(bin, 'dir-tool'), { recursive: true });
  const cases: [string, string, boolean][] = [
    ['abs-good', good, true], ['abs-plain', plain, false], ['abs-missing', join(bin, 'nope'), false],
    ['path-good', 'good-tool', true], ['path-plain', 'plain-tool', false], ['path-dir', 'dir-tool', false],
    ['relative-slash', 'bin/good-tool', false], ['relative-slash-dot', './good-tool', false],
  ];
  for (const [name, tryExec] of cases) writeFileSync(join(apps, `${name}.desktop`), entry(name, `TryExec=${tryExec}\n`));
  const found = (await list(root, { PATH: `${bin}:relative-bin` })).map(app => app.name).sort();
  assert.deepEqual(found, cases.filter(([, , ok]) => ok).map(([name]) => name).sort());
  process.chdir(root);
  try { assert.ok(!(await list(root, { PATH: 'bin' })).some(app => app.name === 'path-good')); } finally { process.chdir('/'); }
}));

test('oversized entries, fifos and symlink registrations are handled without reading unbounded data', posix, tree(async (apps, root) => {
  writeFileSync(join(apps, 'big.desktop'), entry('Big', `Comment=${'x'.repeat(70_000)}\n`));
  execFileSync('mkfifo', [join(root, 'pipe')]);
  symlinkSync(join(root, 'pipe'), join(apps, 'pipe.desktop'));
  const real = join(root, 'real.desktop'); writeFileSync(real, entry('Linked'));
  symlinkSync(real, join(apps, 'link.desktop'));
  mkdirSync(join(apps, 'folder.desktop'));
  const apps2 = await list(root);
  assert.deepEqual(apps2.map(app => app.name), ['Linked']);
}));

test('a registration that appears twice under one prefixed name is dropped instead of picking one', tree(async (apps, root) => {
  mkdirSync(join(apps, 'vendor'));
  writeFileSync(join(apps, 'vendor-tool.desktop'), entry('Flat'));
  writeFileSync(join(apps, 'vendor', 'tool.desktop'), entry('Nested'));
  writeFileSync(join(apps, 'other.desktop'), entry('Other'));
  assert.deepEqual((await list(root)).map(app => app.name), ['Other']);
}));

test('directory depth, scanned item count and catalog size are bounded', tree(async (apps, root) => {
  let deep = apps;
  for (let level = 0; level < 8; level++) { deep = join(deep, `d${level}`); mkdirSync(deep); }
  writeFileSync(join(deep, 'ok.desktop'), entry('Deepest allowed'));
  assert.equal((await list(root)).length, 1);
  mkdirSync(join(deep, 'd8'));
  await assert.rejects(list(root), /LAUNCHER_LIMIT/);
  rmSync(join(apps, 'd0'), { recursive: true });
  const many = join(apps, 'many'); mkdirSync(many);
  for (let index = 0; index < 8_191; index++) writeFileSync(join(many, `f${index}.txt`), '');
  assert.equal((await list(root)).length, 0);
  writeFileSync(join(many, 'one-more.txt'), '');
  await assert.rejects(list(root), /LAUNCHER_LIMIT/);
  rmSync(many, { recursive: true });
  for (let index = 0; index < 2_049; index++) writeFileSync(join(apps, `app${index}.desktop`), entry(`App ${index}`));
  await assert.rejects(list(root), /LAUNCHER_LIMIT/);
  rmSync(join(apps, 'app0.desktop'));
  assert.equal((await list(root)).length, 2_048);
}));

test('relative XDG directories are ignored and only absolute ones are scanned', posix, tree(async (_apps, root) => {
  const cwd = join(root, 'cwd'); mkdirSync(join(cwd, 'applications'), { recursive: true });
  writeFileSync(join(cwd, 'applications', 'relative.desktop'), entry('Relative'));
  const home = join(root, 'home'); mkdirSync(join(home, '.local/share/applications'), { recursive: true });
  writeFileSync(join(home, '.local/share/applications', 'home.desktop'), entry('Home'));
  process.chdir(cwd);
  try {
    const found = await new LinuxAppLauncher({ HOME: home, XDG_DATA_HOME: '.', XDG_DATA_DIRS: `.:${join(root, 'none')}`, DISPLAY: ':0' }, run).list(new AbortController().signal);
    assert.deepEqual(found.map(app => app.name), ['Home']);
  } finally { process.chdir('/'); }
}));
