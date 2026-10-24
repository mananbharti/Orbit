/** TabsScreen interaction proof: every computer tab listed, exact-id activate and close, links sent
 *  with a scheme, and the offline state teaches the one-time extension setup instead of erroring. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { CommandError } = require('@orbit/core');
const { TabsScreen } = require('../dist-test/app/src/screens/TabsScreen.js');

const TABS = [
  { id: 11, title: 'Orbit on GitHub', url: 'https://github.com/mananbharti/Orbit', active: true },
  { id: 12, title: '', url: 'https://www.example.com/page', active: false }];

function fakeApi(overrides = {}) {
  const calls = [];
  return { calls,
    list: async () => { calls.push('list'); return { tabs: TABS }; },
    activate: async id => { calls.push(`activate:${id}`); },
    close: async id => { calls.push(`close:${id}`); },
    open: async url => { calls.push(`open:${url}`); },
    ...overrides };
}
async function mount(api) {
  let r;
  await act(async () => { r = create(React.createElement(TabsScreen, { api, onBack: () => {} })); });
  await act(async () => { await new Promise(res => setTimeout(res, 10)); });
  return r;
}
const textOf = (node, depth = 0) => {
  if (depth > 80) return '';
  const c = node.props && node.props.children;
  if (c === null || c === undefined) return '';
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  if (Array.isArray(c)) return c.map(x => textOf({ props: { children: x } }, depth + 1)).join('');
  if (typeof c === 'object') return textOf(c, depth + 1);
  return '';
};
const outermost = nodes => nodes.filter(n => { let p = n.parent; while (p) { if (nodes.includes(p)) return false; p = p.parent; } return true; });
const allText = r => {
  const parts = [];
  r.root.findAll(n => n.props).forEach(n => {
    const c = n.props.children;
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) c.forEach(x => { if (typeof x === 'string') parts.push(x); });
  });
  return parts.join('');
};
const pressText = async (r, label) => {
  const t = outermost(r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && textOf(n).includes(label)));
  assert.ok(t.length, `no pressable with ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { t[t.length - 1].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};
const urlInput = r => r.root.findAll(n => n.type === 'TextInput')[0];

test('every tab is listed with its host, and the one in front says so', async () => {
  const r = await mount(fakeApi());
  const text = allText(r);
  assert.ok(text.includes('Orbit on GitHub'), text.slice(0, 300));
  assert.ok(text.includes('github.com · in front'), 'the active tab is marked: ' + text.slice(0, 400));
  assert.ok(text.includes('example.com'), 'a titleless tab falls back to its host: ' + text.slice(0, 400));
  r.unmount();
});

test('tapping a tab brings up exactly it; the x closes exactly it', async () => {
  const api = fakeApi();
  const r = await mount(api);
  await pressText(r, 'example.com');
  assert.deepEqual(api.calls.filter(c => c.startsWith('activate')), ['activate:12'], JSON.stringify(api.calls));
  const closes = outermost(r.root.findAll(n => n.props && n.props.accessibilityLabel === 'Close tab' && typeof n.props.onPress === 'function'));
  assert.equal(closes.length, 2, 'each row has its own close');
  await act(async () => { closes[0].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
  assert.deepEqual(api.calls.filter(c => c.startsWith('close')), ['close:11'], 'the first row is tab 11: ' + JSON.stringify(api.calls));
  r.unmount();
});

test('a bare host gets https, a full URL passes through, and the field clears', async () => {
  const api = fakeApi();
  const r = await mount(api);
  await act(async () => { urlInput(r).props.onChangeText('apple.com'); });
  await pressText(r, 'Open');
  assert.deepEqual(api.calls.filter(c => c.startsWith('open')), ['open:https://apple.com'], JSON.stringify(api.calls));
  assert.equal(urlInput(r).props.value, '', 'the field cleared for the next link');
  await act(async () => { urlInput(r).props.onChangeText('http://192.168.1.10:8642/status'); });
  await act(async () => { urlInput(r).props.onSubmitEditing(); await new Promise(res => setTimeout(res, 5)); });
  assert.deepEqual(api.calls.filter(c => c.startsWith('open'))[1], 'open:http://192.168.1.10:8642/status', 'full URL untouched');
  r.unmount();
});

test('an offline extension becomes the setup guide, and check-again recovers', async () => {
  let offline = true;
  const api = fakeApi({ list: async () => {
    api.calls.push('list');
    if (offline) throw new CommandError('TABS_EXTENSION_OFFLINE');
    return { tabs: TABS };
  } });
  const r = await mount(api);
  const text = allText(r);
  assert.ok(text.includes('One-time setup on your computer'), 'the guide, not an error: ' + text.slice(0, 400));
  assert.ok(text.includes('Load unpacked'), 'real steps: ' + text.slice(0, 400));
  offline = false;
  await pressText(r, "I've connected it - check again");
  assert.ok(allText(r).includes('Orbit on GitHub'), 'the tabs arrive once connected: ' + allText(r).slice(0, 300));
  r.unmount();
});

test('an empty browser says so, and other failures stay readable', async () => {
  const r = await mount(fakeApi({ list: async () => ({ tabs: [] }) }));
  assert.ok(allText(r).includes('No tabs right now.'), allText(r).slice(0, 300));
  r.unmount();
  const r2 = await mount(fakeApi({ list: async () => { throw new Error('RAW BLEW UP'); } }));
  assert.ok(!allText(r2).includes('RAW BLEW UP'), 'no raw error leak: ' + allText(r2).slice(0, 400));
  r2.unmount();
});
