/** Verifies the paste keystroke choice per window class: terminals get Ctrl+Shift+V, everything else Ctrl+V, unknown classes default to the GUI binding. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pasteKeySequence } from '../src/dictation/create-insertion.js';

test('terminal window classes paste with ctrl+shift+v', () => {
  for (const cls of ['Xfce4-terminal', 'gnome-terminal-server', 'konsole', 'Alacritty', 'kitty', 'xterm']) {
    assert.equal(pasteKeySequence(cls), 'ctrl+shift+v', cls);
  }
});

test('GUI and unknown classes paste with ctrl+v', () => {
  for (const cls of ['Google-chrome', 'firefox', 'Gedit', 'code', '']) {
    assert.equal(pasteKeySequence(cls), 'ctrl+v', cls || '(empty)');
  }
});
