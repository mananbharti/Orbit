/** Verifies the platform adapter factories pick the right class per OS and fail closed elsewhere; depends on no OS features. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioMixerUnavailable } from '../src/os-integration/audio-mixer.js';
import { ClipboardUnavailable } from '../src/os-integration/clipboard.js';
import { createAppLauncher } from '../src/os-integration/create-app-launcher.js';
import { createAudioMixer } from '../src/os-integration/create-audio-mixer.js';
import { createClipboard } from '../src/os-integration/create-clipboard.js';
import { createSystemControl } from '../src/os-integration/create-system-control.js';
import { SystemControlUnavailable } from '../src/os-integration/system-control.js';

function asPlatform<T>(platform: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try { return run(); } finally { Object.defineProperty(process, 'platform', original); }
}

test('each factory selects the right adapter for the current platform', () => {
  const expected = process.platform === 'win32' ? 'Windows' : 'Linux';
  for (const create of [createAppLauncher, createAudioMixer, createSystemControl]) {
    assert.ok(create().constructor.name.startsWith(expected), `${create().constructor.name} on ${process.platform}`);
  }
  try {
    assert.ok(createClipboard().constructor.name.startsWith(expected));
  } catch (error) {
    assert.ok(error instanceof ClipboardUnavailable, 'a host without clipboard tools fails closed instead');
  }
});

test('Windows gets the Windows adapters', () => {
  asPlatform('win32', () => {
    assert.equal(createAppLauncher().constructor.name, 'WindowsAppLauncher');
    assert.equal(createAudioMixer().constructor.name, 'WindowsAudioMixer');
    assert.equal(createClipboard().constructor.name, 'WindowsClipboard');
    assert.equal(createSystemControl().constructor.name, 'WindowsSystemControl');
  });
});

test('Linux gets the Linux adapters', () => {
  asPlatform('linux', () => {
    assert.equal(createAppLauncher().constructor.name, 'LinuxAppLauncher');
    assert.equal(createAudioMixer().constructor.name, 'LinuxAudioMixer');
    try { assert.equal(createClipboard().constructor.name, 'LinuxClipboard'); }
    catch (error) { assert.ok(error instanceof ClipboardUnavailable, 'no clipboard tool on this host: fails closed'); }
    assert.equal(createSystemControl().constructor.name, 'LinuxSystemControl');
  });
});

test('unsupported platforms fail closed, never silently', async () => {
  asPlatform('darwin', () => {
    assert.throws(() => createAppLauncher(), /LAUNCHER_UNAVAILABLE/);
    assert.throws(() => createClipboard(), ClipboardUnavailable);
    assert.throws(() => createSystemControl(), SystemControlUnavailable);
    const mixer = createAudioMixer();
    return (async () => {
      await assert.rejects(mixer.listSessions(), AudioMixerUnavailable);
      await assert.rejects(mixer.setSession('1', 50), AudioMixerUnavailable);
    })();
  });
});
