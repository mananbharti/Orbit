/** Verifies the paste keystroke choice per window class: allowlisted terminals get Ctrl+Shift+V, allowlisted GUI text apps Ctrl+V, and unknown classes get no keystroke at all. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pasteKeySequence } from '../src/dictation/create-insertion.js';

test('allowlisted terminal window classes paste with ctrl+shift+v', () => {
  for (const cls of ['Xfce4-terminal', 'gnome-terminal-server', 'konsole', 'Alacritty', 'kitty', 'xterm']) {
    assert.equal(pasteKeySequence(cls), 'ctrl+shift+v', cls);
  }
});

test('allowlisted GUI text app classes paste with ctrl+v', () => {
  for (const cls of ['Google-chrome', 'firefox', 'Gedit', 'code', 'Mousepad', 'libreoffice-writer']) {
    assert.equal(pasteKeySequence(cls), 'ctrl+v', cls);
  }
});

test('unknown or empty classes get no keystroke', () => {
  for (const cls of ['XMessage', 'Nautilus', 'Gimp', '', 'random-app-9000']) {
    assert.equal(pasteKeySequence(cls), undefined, cls || '(empty)');
  }
});
