/** PresentScreen interaction proof: slide keys leave as exact key events, and the laser pad holds
 *  Ctrl+click down for the drag and lifts both on release - never a stuck modifier on his computer. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { PresentScreen } = require('../dist-test/app/src/screens/PresentScreen.js');

function fakeApi(overrides = {}) {
  const calls = []; const pushes = [];
  let state = { status: 'idle' };
  const listeners = new Set();
  const emit = () => listeners.forEach(l => l());
  return { calls, pushes,
    _setState: s => { state = s; emit(); },
    subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    getState: () => state,
    begin: async () => { calls.push('begin'); state = { status: 'active' }; emit(); },
    end: async () => { calls.push('end'); state = { status: 'ended' }; emit(); },
    push: ev => { pushes.push(ev); },
    ...overrides };
}
async function mount(api) {
  let r;
  await act(async () => { r = create(React.createElement(PresentScreen, { api, onBack: () => {} })); });
  await act(async () => { await new Promise(res => setTimeout(res, 5)); });
  return r;
}
async function mountActive(api) {
  const r = await mount(api);
  await pressText(r, 'Start presenting');
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
  assert.ok(t.length, `no pressable labelled ${label}`);
  await act(async () => { t[0].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};

test('presenting starts only with approval, told up front', async () => {
  const api = fakeApi();
  const r = await mount(api);
  assert.ok(allText(r).includes('asks its owner to approve first'), allText(r).slice(0, 400));
  await pressText(r, 'Start presenting');
  assert.deepEqual(api.calls.filter(c => c === 'begin'), ['begin']);
  assert.ok(allText(r).includes('Touch and drag for the laser pointer'), 'the controls are live: ' + allText(r).slice(0, 400));
  r.unmount();
});

test('a refused session says the computer did not approve', async () => {
  const api = fakeApi({ begin: async () => { throw new Error('BIOMETRIC_REQUIRED'); } });
  const r = await mount(api);
  await pressText(r, 'Start presenting');
  assert.ok(allText(r).includes('Your computer did not approve control.'), allText(r).slice(0, 400));
  r.unmount();
});

test('every slide control sends its exact key', async () => {
  const api = fakeApi();
  const r = await mountActive(api);
  await pressLabel(r, 'Next slide');
  await pressLabel(r, 'Previous slide');
  await pressText(r, 'Start deck');
  await pressText(r, 'Black screen');
  await pressText(r, 'White screen');
  await pressText(r, 'End deck');
  assert.deepEqual(api.pushes, [
    { t: 'key', key: 'right' }, { t: 'key', key: 'left' }, { t: 'key', key: 'f5' },
    { t: 'key', key: 'b' }, { t: 'key', key: 'w' }, { t: 'key', key: 'escape' }], JSON.stringify(api.pushes));
  r.unmount();
});

test('the laser holds ctrl and the button for the drag, and lifts both on release', async () => {
  const api = fakeApi();
  const r = await mountActive(api);
  const pad = r.root.findAll(n => n.props && n.props.accessibilityLabel === 'Laser pointer pad')[0];
  const touch = (x, y) => ({ nativeEvent: { pageX: x, pageY: y }, persist() {},
    touchHistory: { touchBank: [], numberActiveTouches: 0, indexOfSingleActiveTouch: -1, mostRecentTimeStamp: Date.now() } });
  await act(async () => { pad.props.onResponderGrant(touch(10, 10)); });
  assert.deepEqual(api.pushes, [
    { t: 'key', key: 'v', modifiers: ['ctrl'], action: 'down' },
    { t: 'button', button: 'left', action: 'down' }], 'the hold: ' + JSON.stringify(api.pushes));
  await act(async () => { pad.props.onResponderMove(touch(40, 30)); });
  assert.ok(api.pushes.some(p => p.t === 'move'), 'the drag moved: ' + JSON.stringify(api.pushes));
  await act(async () => { pad.props.onResponderRelease(touch(40, 30)); });
  const tail = api.pushes.slice(-2);
  assert.deepEqual(tail, [
    { t: 'button', button: 'left', action: 'up' },
    { t: 'key', key: 'v', modifiers: ['ctrl'], action: 'up' }], 'nothing left held on his computer: ' + JSON.stringify(api.pushes));
  r.unmount();
});

test('stopping ends the session', async () => {
  const api = fakeApi();
  const r = await mountActive(api);
  await pressText(r, 'Stop presenting');
  assert.ok(api.calls.filter(c => c === 'end').length >= 1, JSON.stringify(api.calls));
  r.unmount();
});
