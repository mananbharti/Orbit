/** PairScreen interaction proof: camera permission, QR scan dedup, paste fallback, error + retry.
 *  A double-fired barcode event must never pair twice, and a rejected pair must let you try again. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const camera = require('expo-camera');
const { PairScreen } = require('../dist-test/app/src/screens/PairScreen.js');

function mount(onScanned, props = {}) {
  const calls = [];
  let r;
  return (async () => {
    const scanned = onScanned || (async text => { calls.push(text); });
    await act(async () => { r = create(React.createElement(PairScreen, { onScanned: scanned, onBack: () => calls.push('back'), ...props })); });
    return { r, calls };
  })();
}
const allText = r => {
  const parts = [];
  r.root.findAll(n => typeof n.type === 'string' || typeof n.type === 'function').forEach(n => {
    const c = n.props && n.props.children;
    if (typeof c === 'string') parts.push(c);
  });
  return parts.join('|');
};
const pressText = async (r, label) => {
  const targets = r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && (() => { const c = n.props.children; const flat = x => x === null || x === undefined ? '' : typeof x === 'string' ? x : Array.isArray(x) ? x.map(flat).join('') : flat(x.props && x.props.children); return flat(c).includes(label); })());
  assert.ok(targets.length >= 1, `no pressable with ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { targets[targets.length - 1].props.onPress(); });
};
const cameraView = r => r.root.findAll(n => n.type === 'CameraView')[0];

test('without camera permission the screen asks once, with the reason', async () => {
  camera.permission = { granted: false }; camera.requestCalls = 0;
  const { r } = await mount();
  assert.ok(allText(r).includes('Orbit needs the camera only to read the pairing code.'), allText(r).slice(0, 300));
  assert.ok(!cameraView(r), 'no camera preview before permission');
  await pressText(r, 'Allow camera');
  assert.equal(camera.requestCalls, 1, 'the button asked for the permission');
  r.unmount();
});

test('a scanned QR code pairs exactly once - a double-fired event never pairs twice', async () => {
  camera.permission = { granted: true };
  const { r, calls } = await mount(async text => { calls.push(text); });
  const view = cameraView(r);
  assert.ok(view, 'camera preview is up once permitted');
  await act(async () => { await view.props.onBarcodeScanned({ data: '{"v":1,"url":"ws://mac:8642"}' }); });
  await act(async () => { await view.props.onBarcodeScanned({ data: '{"v":1,"url":"ws://mac:8642"}' }); });
  assert.deepEqual(calls, ['{"v":1,"url":"ws://mac:8642"}'], 'one pair per screen: ' + JSON.stringify(calls));
  r.unmount();
});

test('a rejected pair explains itself, then lets you scan again', async () => {
  camera.permission = { granted: true };
  const attempts = [];
  const { r } = await mount(async text => { attempts.push(text); if (attempts.length === 1) throw new Error('ECONNREFUSED'); });
  const view = cameraView(r);
  await act(async () => { await view.props.onBarcodeScanned({ data: 'code-1' }); });
  assert.ok(allText(r).length > 0 && !allText(r).includes('ECONNREFUSED'), 'no raw error leak: ' + allText(r).slice(0, 400));
  await act(async () => { await new Promise(res => setTimeout(res, 1700)); }); // the screen re-arms after 1.5s
  await act(async () => { await view.props.onBarcodeScanned({ data: 'code-2' }); });
  assert.deepEqual(attempts, ['code-1', 'code-2'], 'the retry reached the pair call: ' + JSON.stringify(attempts));
  r.unmount();
});

test('the paste fallback is disabled empty and pairs with the trimmed code', async () => {
  camera.permission = { granted: false };
  const { r, calls } = await mount(async text => { calls.push(text); });
  const pairButton = () => r.root.findAll(n => n.props && n.props.accessibilityLabel === 'Pair with pasted code')[0];
  assert.equal(pairButton().props.disabled, true, 'an empty paste cannot pair');
  const input = r.root.findAll(n => n.type === 'TextInput')[0];
  await act(async () => { input.props.onChangeText('  {"v":1,"url":"ws://mini:8642"}  '); });
  assert.equal(pairButton().props.disabled, false);
  await act(async () => { pairButton().props.onPress(); await new Promise(res => setTimeout(res, 0)); });
  assert.deepEqual(calls, ['{"v":1,"url":"ws://mini:8642"}'], 'trimmed paste: ' + JSON.stringify(calls));
  r.unmount();
});

test('while a pair is in flight the scanner closes, and it reopens when the pair resolves', async () => {
  camera.permission = { granted: true };
  let release;
  const { r } = await mount(() => new Promise(res => { release = res; }));
  await act(async () => { cameraView(r).props.onBarcodeScanned({ data: 'x' }); });
  assert.equal(cameraView(r).props.onBarcodeScanned, undefined, 'the scanner stops accepting codes while busy');
  await act(async () => { release(); await new Promise(res => setTimeout(res, 0)); });
  assert.equal(typeof cameraView(r).props.onBarcodeScanned, 'function', 'the scanner reopens once the pair resolves');
  r.unmount();
});
