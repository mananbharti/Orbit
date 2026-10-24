/** MemoryScreen interaction proof: search, save and forget hit the computer's memory with exact
 *  payloads, and the screen always says where the facts live - on the computer only. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { MemoryScreen } = require('../dist-test/app/src/screens/MemoryScreen.js');

const HITS = [{ id: 'h1', name: 'Asha', via: 'from a task', facts: ['prefers window seats', 'allergic to peanuts'] }];

function fakeApi(overrides = {}) {
  const calls = [];
  return { calls,
    recall: async q => { calls.push(`recall:${q}`); return HITS; },
    remember: async entry => { calls.push(`remember:${JSON.stringify(entry)}`); },
    forget: async id => { calls.push(`forget:${id}`); },
    ...overrides };
}
async function mount(api) {
  let r;
  await act(async () => { r = create(React.createElement(MemoryScreen, { api, onBack: () => {} })); });
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
  await act(async () => { t[t.length - 1].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};
const field = (r, label) => r.root.findAll(n => n.props && n.props.accessibilityLabel === label)[0];

test('before any search the screen says where facts live', async () => {
  const r = await mount(fakeApi());
  const text = allText(r);
  assert.ok(text.includes('Kept on your computer only.'), text.slice(0, 300));
  assert.ok(text.includes('stay on your computer'), text.slice(0, 400));
  r.unmount();
});

test('searching recalls with the exact query and renders the hits', async () => {
  const api = fakeApi();
  const r = await mount(api);
  await act(async () => { field(r, 'Search memory').props.onChangeText('asha'); });
  await act(async () => { field(r, 'Search memory').props.onSubmitEditing(); await new Promise(res => setTimeout(res, 5)); });
  assert.deepEqual(api.calls, ['recall:asha'], JSON.stringify(api.calls));
  const text = allText(r);
  assert.ok(text.includes('Asha') && text.includes('prefers window seats') && text.includes('allergic to peanuts'), text.slice(0, 400));
  assert.ok(text.includes('from a task'), 'the provenance shows: ' + text.slice(0, 400));
  r.unmount();
});

test('an empty result says nothing was found; an empty query returns to the explainer', async () => {
  const api = fakeApi({ recall: async () => [] });
  const r = await mount(api);
  await act(async () => { field(r, 'Search memory').props.onChangeText('nobody'); });
  await act(async () => { field(r, 'Search memory').props.onSubmitEditing(); await new Promise(res => setTimeout(res, 5)); });
  assert.ok(allText(r).includes('Nothing found.'), allText(r).slice(0, 400));
  await act(async () => { field(r, 'Search memory').props.onChangeText('   '); });
  await act(async () => { field(r, 'Search memory').props.onSubmitEditing(); await new Promise(res => setTimeout(res, 5)); });
  assert.ok(allText(r).includes('stay on your computer'), 'back to the explainer: ' + allText(r).slice(0, 400));
  r.unmount();
});

test('saving sends the exact entry, clears the fields and confirms', async () => {
  const api = fakeApi();
  const r = await mount(api);
  await act(async () => { field(r, 'Name').props.onChangeText('  Asha  '); });
  await act(async () => { field(r, 'Fact').props.onChangeText(' prefers window seats '); });
  await pressText(r, 'Save');
  assert.deepEqual(api.calls.filter(c => c.startsWith('remember')), ['remember:{"name":"Asha","fact":"prefers window seats"}'], JSON.stringify(api.calls));
  assert.equal(field(r, 'Name').props.value, '', 'the name field cleared');
  assert.equal(field(r, 'Fact').props.value, '', 'the fact field cleared');
  assert.ok(allText(r).includes('Saved on your computer'), allText(r).slice(0, 400));
  r.unmount();
});

test('a name alone saves without a dangling empty fact', async () => {
  const api = fakeApi();
  const r = await mount(api);
  await act(async () => { field(r, 'Name').props.onChangeText('Asha'); });
  await pressText(r, 'Save');
  assert.deepEqual(api.calls.filter(c => c.startsWith('remember')), ['remember:{"name":"Asha"}'], JSON.stringify(api.calls));
  r.unmount();
});

test('forgetting removes exactly that memory from the computer and the list', async () => {
  const api = fakeApi();
  const r = await mount(api);
  await act(async () => { field(r, 'Search memory').props.onChangeText('asha'); });
  await act(async () => { field(r, 'Search memory').props.onSubmitEditing(); await new Promise(res => setTimeout(res, 5)); });
  await pressText(r, 'Forget');
  assert.deepEqual(api.calls.filter(c => c.startsWith('forget')), ['forget:h1'], JSON.stringify(api.calls));
  assert.ok(!allText(r).includes('allergic to peanuts'), 'the row is gone: ' + allText(r).slice(0, 400));
  r.unmount();
});
