/** AppsScreen interaction proof: launching, search, pins, scenes and the long-press menu.
 *  The grid is the phone's launcher for the computer - every tap must hit the exact app. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { OutcomeUnknown } = require('@orbit/core');
const { AppsScreen } = require('../dist-test/app/src/screens/AppsScreen.js');

const APPS = [
  { appId: 'com.apple.Safari', name: 'Safari' },
  { appId: 'com.apple.Mail', name: 'Mail' },
  { appId: 'com.apple.Notes', name: 'Notes' }];
const SCENES = [{ id: 'scene-1', name: 'Work', appIds: ['com.apple.Safari', 'com.apple.Mail'] }];

function fakeApi(overrides = {}) {
  const calls = [];
  return { calls,
    list: async () => { calls.push('list'); return APPS; },
    getPinned: () => ['com.apple.Safari'],
    scenes: async () => SCENES,
    icons: async ids => { calls.push(`icons:${ids.length}`); return ids.map(() => null); },
    launch: async id => { calls.push(`launch:${id}`); },
    launchScene: async id => { calls.push(`launchScene:${id}`); return { opened: [], failed: [] }; },
    pin: async id => { calls.push(`pin:${id}`); return ['com.apple.Safari', id]; },
    unpin: async id => { calls.push(`unpin:${id}`); return []; },
    reorder: async ids => ids,
    saveScene: async (name, ids, id) => { calls.push(`saveScene:${name}:${ids.join('+')}${id ? ':' + id : ''}`); return []; },
    deleteScene: async id => { calls.push(`deleteScene:${id}`); return []; },
    ...overrides };
}
async function mount(api, props = {}) {
  let r;
  await act(async () => { r = create(React.createElement(AppsScreen, { api, onBack: () => {}, ...props })); });
  await act(async () => { await new Promise(res => setTimeout(res, 20)); });
  return r;
}
const allText = r => {
  const parts = [];
  r.root.findAll(n => n.props).forEach(n => { const c = n.props.children; if (typeof c === 'string') parts.push(c); });
  return parts.join('|');
};
// Pressable renders several nested nodes with the same label; count each control once (outermost only).
const outermost = nodes => nodes.filter(n => { let p = n.parent; while (p) { if (nodes.includes(p)) return false; p = p.parent; } return true; });
const textOf = (node, depth = 0) => {
  if (depth > 30) return '';
  const c = node.props && node.props.children;
  if (c === null || c === undefined) return '';
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  if (Array.isArray(c)) return c.map(x => textOf({ props: { children: x } }, depth + 1)).join('');
  if (typeof c === 'object') return textOf(c, depth + 1);
  return '';
};
const tiles = r => outermost(r.root.findAll(n => n.props && typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Open ')));
const tile = (r, name) => tiles(r).find(n => n.props.accessibilityLabel === `Open ${name} on your computer`);
const pressLabel = async (r, label) => {
  const t = r.root.findAll(n => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  assert.ok(t.length, `no pressable labelled ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { t[0].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};
const searchInput = r => r.root.findAll(n => n.type === 'TextInput' && n.props.accessibilityLabel === 'Search apps')[0];

test('tapping a tile launches exactly that app and marks it open', async () => {
  const api = fakeApi();
  const r = await mount(api);
  assert.ok(tile(r, 'Mail'), 'the grid is up: ' + allText(r).slice(0, 300));
  await act(async () => { tile(r, 'Mail').props.onPress(); await new Promise(res => setTimeout(res, 5)); });
  assert.deepEqual(api.calls.filter(c => c.startsWith('launch')), ['launch:com.apple.Mail'], JSON.stringify(api.calls));
  r.unmount();
});

test('a failed launch explains itself and refreshes the catalog; an unknown outcome does not churn it', async () => {
  const api = fakeApi({ launch: async () => { throw new Error('boom raw socket'); } });
  const r = await mount(api);
  await act(async () => { tile(r, 'Mail').props.onPress(); await new Promise(res => setTimeout(res, 5)); });
  const text = allText(r);
  assert.ok(!text.includes('boom raw socket'), 'no raw error leak: ' + text.slice(0, 400));
  assert.equal(api.calls.filter(c => c === 'list').length, 2, 'a clean failure reloads the catalog');
  const api2 = fakeApi({ launch: async () => { throw new OutcomeUnknown('unknown'); } });
  const r2 = await mount(api2);
  await act(async () => { tile(r2, 'Mail').props.onPress(); await new Promise(res => setTimeout(res, 5)); });
  assert.equal(api2.calls.filter(c => c === 'list').length, 1, 'an unknown outcome does not churn the catalog');
  r.unmount(); r2.unmount();
});

test('while one app is launching every tile is inert', async () => {
  let release;
  const api = fakeApi({ launch: async id => { api.calls.push(`launch:${id}`); await new Promise(res => { release = res; }); } });
  const r = await mount(api);
  await act(async () => { tile(r, 'Mail').props.onPress(); });
  assert.ok(tiles(r).every(n => n.props.disabled === true), 'all tiles disabled while launching');
  await act(async () => { release(); await new Promise(res => setTimeout(res, 5)); });
  assert.ok(tiles(r).every(n => !n.props.disabled), 'tiles live again after the launch resolves');
  assert.deepEqual(api.calls.filter(c => c.startsWith('launch')), ['launch:com.apple.Mail'], 'exactly one launch left the phone');
  r.unmount();
});

test('search narrows the grid and says so when nothing matches', async () => {
  const api = fakeApi();
  const r = await mount(api);
  assert.equal(tiles(r).length, 4, 'pinned Safari leads the header and still sits in the grid: ' + JSON.stringify(tiles(r).map(n => n.props.accessibilityLabel)));
  await act(async () => { searchInput(r).props.onChangeText('saf'); });
  assert.deepEqual(tiles(r).map(n => n.props.accessibilityLabel), ['Open Safari on your computer'], allText(r).slice(0, 300));
  await act(async () => { searchInput(r).props.onChangeText('zzz'); });
  assert.equal(tiles(r).length, 0);
  assert.ok(allText(r).includes('No apps match.'), allText(r).slice(0, 400));
  r.unmount();
});

test('pinned favourites lead, in the owner’s order; a vanished app skips silently', async () => {
  const api = fakeApi({ getPinned: () => ['com.apple.Gone', 'com.apple.Notes', 'com.apple.Safari'] });
  const r = await mount(api);
  const text = allText(r);
  assert.ok(text.includes('PINNED'), text.slice(0, 300));
  const header = r.root.findAll(n => n.props && n.props.children === 'PINNED')[0];
  const headerSection = header.parent.parent;
  const names = outermost(headerSection.findAll(n => n.props && typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Open ')))
    .map(n => n.props.accessibilityLabel);
  assert.deepEqual(names, ['Open Notes on your computer', 'Open Safari on your computer'], 'pinned order, gone app skipped: ' + JSON.stringify(names));
  r.unmount();
});

test('long-press offers pin for an unpinned app and reorder for a pinned one', async () => {
  const api = fakeApi();
  const alerts = [];
  const realAlert = rn.Alert.alert;
  rn.Alert.alert = (title, message, buttons) => { alerts.push({ title, buttons }); };
  try {
    const r = await mount(api);
    await act(async () => { tile(r, 'Mail').props.onLongPress(); });
    assert.deepEqual(alerts[0].buttons.map(b => b.text), ['Open', 'Pin to top', 'Cancel'], JSON.stringify(alerts[0].buttons.map(b => b.text)));
    await act(async () => { alerts[0].buttons[1].onPress(); await new Promise(res => setTimeout(res, 5)); });
    assert.deepEqual(api.calls.filter(c => c.startsWith('pin')), ['pin:com.apple.Mail'], JSON.stringify(api.calls));
    await act(async () => { tile(r, 'Safari').props.onLongPress(); });
    assert.deepEqual(alerts[1].buttons.map(b => b.text), ['Open', 'Unpin', 'Move later', 'Cancel'], 'pinned app menu: ' + JSON.stringify(alerts[1].buttons.map(b => b.text)));
    r.unmount();
  } finally { rn.Alert.alert = realAlert; }
});

test('building a scene: save stays off until named with picks, then saves the exact set', async () => {
  const api = fakeApi();
  const r = await mount(api);
  await pressLabel(r, 'New scene');
  const saveBtn = () => r.root.findAll(n => n.props && typeof n.props.onPress === 'function').find(n => textOf(n).startsWith('Save scene'));
  assert.ok(saveBtn().props.disabled, 'save disabled with no name and no picks');
  await act(async () => { r.root.findAll(n => n.type === 'TextInput' && n.props.accessibilityLabel === 'Scene name')[0].props.onChangeText('Focus'); });
  await act(async () => { tile(r, 'Safari').props.onPress(); });
  await act(async () => { tile(r, 'Notes').props.onPress(); });
  assert.ok(!saveBtn().props.disabled, 'named with picks, save is live');
  await act(async () => { saveBtn().props.onPress(); await new Promise(res => setTimeout(res, 5)); });
  assert.deepEqual(api.calls.filter(c => c.startsWith('saveScene')), ['saveScene:Focus:com.apple.Safari+com.apple.Notes'], JSON.stringify(api.calls));
  r.unmount();
});

test('a scene chip runs the scene, and partial failure names the apps that did not open', async () => {
  const api = fakeApi({ launchScene: async id => { api.calls.push(`launchScene:${id}`); return { opened: ['Safari'], failed: ['Mail'] }; } });
  const r = await mount(api);
  await pressLabel(r, 'Launch scene Work');
  assert.deepEqual(api.calls.filter(c => c.startsWith('launchScene')), ['launchScene:scene-1'], JSON.stringify(api.calls));
  assert.ok(allText(r).includes('Could not open: Mail'), allText(r).slice(0, 400));
  r.unmount();
});

test('an empty computer says so instead of showing a dead grid', async () => {
  const api = fakeApi({ list: async () => [], getPinned: () => [], scenes: async () => [] });
  const r = await mount(api);
  assert.ok(allText(r).includes('No apps found on your computer.'), allText(r).slice(0, 400));
  r.unmount();
});
