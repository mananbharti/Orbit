/** ControlScreen interaction proof: a desktop that answers SYSTEM_UNAVAILABLE for volume gets NO
 *  dead volume card (it hides like theme/brightness); a capable desktop shows the live level. */
require('./harness');
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
require('react-native-web').Platform.OS = 'ios';
const { ControlScreen } = require('../dist-test/app/src/screens/ControlScreen.js');
const { SystemApi } = require('../dist-test/core/src/system.js');
const { CommandError } = require('../dist-test/core/src/session.js');

let renderers = [];
afterEach(() => { for (const r of renderers) r.unmount(); renderers = []; });

function sessionWith(handlers) {
  return {
    status: 'connected',
    onEvent: () => () => {},
    onStatus: () => () => {},
    command: async type => {
      if (handlers[type]) return handlers[type]();
      throw new Error('unexpected command ' + type);
    },
  };
}
const BASE = {
  'system.brightness.get': () => ({ level: null }),
  'system.mode.get': () => ({ theme: null, nightLight: null }),
  'system.audio.sessions': () => ({ sessions: [] }),
};
async function mount(api) {
  let r;
  await act(async () => { r = create(React.createElement(ControlScreen, { api, onBack: () => {}, onPanic: () => {} })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); // flush the mount-time capability probes
  renderers.push(r);
  return r;
}
const allText = root => {
  try { return root.root.findAllByType('Text' in {} ? 'never' : require('react-native-web').Text).map(n => n.props.children).flat(9).join(' '); }
  catch { return JSON.stringify(root.toJSON()); }
};

test('control screen hides the volume card when the computer has no sound control', async () => {
  const api = new SystemApi(sessionWith({ ...BASE, 'system.volume.get': () => { throw new CommandError('SYSTEM_UNAVAILABLE'); } }));
  const r = await mount(api);
  const text = allText(r);
  assert.ok(!text.includes('VOLUME'), 'dead VOLUME card must not render: ' + text.slice(0, 300));
  assert.ok(!text.includes('Volume down'), 'volume steppers must not render');
});

test('control screen shows the live volume when the computer answers', async () => {
  const api = new SystemApi(sessionWith({ ...BASE, 'system.volume.get': () => ({ level: 40, muted: false }) }));
  const r = await mount(api);
  const text = allText(r);
  assert.ok(text.includes('VOLUME'), 'VOLUME section missing: ' + text.slice(0, 300));
  assert.ok(text.includes('40%'), 'live level missing: ' + text.slice(0, 300));
});
