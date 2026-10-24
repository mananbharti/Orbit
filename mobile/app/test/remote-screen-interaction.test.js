/** RemoteScreen interaction proof: sessions start only with computer approval, every pad gesture and
 *  key leaves the phone as the exact input event, and control stops cleanly. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { RemoteScreen } = require('../dist-test/app/src/screens/RemoteScreen.js');

const MACROS = [{ id: 'm1', name: 'Paste plain', steps: [{ key: 'v', modifiers: ['meta', 'shift'] }] }];

function fakeApi(overrides = {}) {
  const calls = []; const pushes = [];
  let state = { status: 'idle' };
  const listeners = new Set();
  const emit = () => listeners.forEach(l => l());
  const api = { calls, pushes,
    _setState: s => { state = s; emit(); },
    subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    getState: () => state,
    begin: async () => { calls.push('begin'); state = { status: 'active' }; emit(); },
    end: async () => { calls.push('end'); state = { status: 'ended' }; emit(); },
    push: ev => { pushes.push(ev); },
    macros: async () => MACROS,
    runMacro: async m => { calls.push(`runMacro:${m.id}`); },
    saveMacro: async (name, steps) => { calls.push(`saveMacro:${name}:${JSON.stringify(steps)}`); return [...MACROS, { id: 'm2', name, steps }]; },
    deleteMacro: async id => { calls.push(`deleteMacro:${id}`); return []; },
    ...overrides };
  return api;
}
async function mount(api, props = {}) {
  let r;
  await act(async () => { r = create(React.createElement(RemoteScreen, { api, onBack: () => {}, ...props })); });
  await act(async () => { await new Promise(res => setTimeout(res, 10)); });
  return r;
}
async function mountActive(api, props = {}) {
  const r = await mount(api, props);
  await pressText(r, 'Start controlling');
  await act(async () => { await new Promise(res => setTimeout(res, 5)); });
  return r;
}
const allText = r => {
  const parts = [];
  r.root.findAll(n => n.props).forEach(n => {
    const c = n.props.children;
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) c.forEach(x => { if (typeof x === 'string') parts.push(x); });
  });
  return parts.join('');
};
const outermost = nodes => nodes.filter(n => { let p = n.parent; while (p) { if (nodes.includes(p)) return false; p = p.parent; } return true; });
const pressText = async (r, label) => {
  const t = outermost(r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && (() => { const c = n.props.children; const flat = x => x === null || x === undefined ? '' : typeof x === 'string' ? x : Array.isArray(x) ? x.map(flat).join('') : typeof x === 'object' ? flat(x.props && x.props.children) : ''; return flat(c).includes(label); })()));
  assert.ok(t.length, `no pressable with ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { t[0].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};
const pressLabel = async (r, label) => {
  const t = outermost(r.root.findAll(n => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function'));
  assert.ok(t.length, `no pressable labelled ${label}: ` + allText(r).slice(0, 500));
  await act(async () => { t[0].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};

test('control starts only when asked, with the approval story told up front', async () => {
  const api = fakeApi();
  const r = await mount(api);
  assert.ok(allText(r).includes('asks its owner to approve every session'), allText(r).slice(0, 400));
  await pressText(r, 'Start controlling');
  assert.deepEqual(api.calls.filter(c => c === 'begin'), ['begin']);
  assert.ok(allText(r).includes('Drag to move · tap to click'), 'the pad is live: ' + allText(r).slice(0, 400));
  r.unmount();
});

test('a refused session says the computer did not approve', async () => {
  const api = fakeApi({ begin: async () => { throw new Error('BIOMETRIC_REQUIRED'); } });
  const r = await mount(api);
  await pressText(r, 'Start controlling');
  assert.ok(allText(r).includes('Your computer did not approve control.'), allText(r).slice(0, 400));
  r.unmount();
});

test('a drag moves the pointer scaled, a tap clicks', async () => {
  const api = fakeApi();
  const r = await mountActive(api);
  const pad = r.root.findAll(n => n.props && n.props.accessibilityLabel === 'Trackpad')[0];
  // RNW's PanResponder reads e.touchHistory; the fake gesture carries an empty bank (centroids read 0).
  const touch = (x, y) => ({ nativeEvent: { pageX: x, pageY: y }, persist() {},
    touchHistory: { touchBank: [], numberActiveTouches: 0, indexOfSingleActiveTouch: -1, mostRecentTimeStamp: Date.now() } });
  await act(async () => {
    pad.props.onResponderGrant(touch(100, 100));
    pad.props.onResponderMove(touch(110, 105));
    pad.props.onResponderRelease(touch(110, 105));
  });
  const move = api.pushes.find(p => p.t === 'move');
  assert.ok(move, 'a move event left the phone: ' + JSON.stringify(api.pushes));
  assert.equal(Math.round(move.dx), 16, 'dx scaled by 1.6: ' + JSON.stringify(move));
  assert.equal(Math.round(move.dy), 8);
  assert.ok(!api.pushes.some(p => p.t === 'button'), 'a real drag does not also click');
  api.pushes.length = 0;
  await act(async () => {
    pad.props.onResponderGrant(touch(50, 50));
    pad.props.onResponderRelease(touch(50, 50));
  });
  assert.deepEqual(api.pushes, [{ t: 'button', button: 'left', action: 'click' }], 'a tap is a click: ' + JSON.stringify(api.pushes));
  r.unmount();
});

test('the click buttons send exact button events', async () => {
  const api = fakeApi();
  const r = await mountActive(api);
  await pressText(r, 'Left click');
  await pressText(r, 'Right click');
  assert.deepEqual(api.pushes, [{ t: 'button', button: 'left', action: 'click' }, { t: 'button', button: 'right', action: 'click' }], JSON.stringify(api.pushes));
  r.unmount();
});

test('the full keyboard sends exact keys, and a modifier arms exactly one key', async () => {
  const api = fakeApi();
  const r = await mountActive(api);
  await pressText(r, 'Full keyboard');
  await pressLabel(r, 'Key a');
  assert.deepEqual(api.pushes, [{ t: 'key', key: 'a' }], JSON.stringify(api.pushes));
  await pressLabel(r, 'Ctrl modifier');
  await pressLabel(r, 'Key c');
  assert.deepEqual(api.pushes[1], { t: 'key', key: 'c', modifiers: ['ctrl'] }, 'the chord: ' + JSON.stringify(api.pushes));
  await pressLabel(r, 'Key v');
  assert.deepEqual(api.pushes[2], { t: 'key', key: 'v' }, 'the modifier disarmed after one key: ' + JSON.stringify(api.pushes));
  r.unmount();
});

test('typed text streams as keystrokes', async () => {
  const api = fakeApi();
  const r = await mountActive(api);
  const keyboard = r.root.findAll(n => n.props && n.props.accessibilityLabel === 'Keyboard')[0];
  await act(async () => { keyboard.props.onChangeText('hi'); });
  assert.deepEqual(api.pushes, [{ t: 'text', text: 'hi' }], JSON.stringify(api.pushes));
  r.unmount();
});

test('a macro chip runs its macro, and composing saves exact steps', async () => {
  const api = fakeApi();
  const r = await mountActive(api);
  await pressLabel(r, 'Run macro Paste plain');
  assert.deepEqual(api.calls.filter(c => c.startsWith('runMacro')), ['runMacro:m1'], JSON.stringify(api.calls));
  await pressLabel(r, 'New macro');
  const nameField = r.root.findAll(n => n.props && n.props.accessibilityLabel === 'Macro name')[0];
  await act(async () => { nameField.props.onChangeText('Paste twice'); });
  await pressText(r, '+ Add step: V');
  await pressText(r, 'Win'); // the meta modifier wears the Win label
  await pressText(r, '+ Add step: Win+V');
  await pressText(r, 'Save macro');
  assert.deepEqual(api.calls.filter(c => c.startsWith('saveMacro')),
    ['saveMacro:Paste twice:[{"key":"v"},{"key":"v","modifiers":["meta"]}]'], JSON.stringify(api.calls));
  r.unmount();
});

test('stopping control ends the session, and an ended session says why', async () => {
  const api = fakeApi();
  const r = await mountActive(api);
  await pressText(r, 'Stop controlling');
  assert.deepEqual(api.calls.filter(c => c === 'end').length >= 1, true, 'end called: ' + JSON.stringify(api.calls));
  await act(async () => { api._setState({ status: 'ended', error: 'connection dropped' }); });
  assert.ok(allText(r).includes('Control ended: connection dropped'), allText(r).slice(0, 400));
  r.unmount();
});
