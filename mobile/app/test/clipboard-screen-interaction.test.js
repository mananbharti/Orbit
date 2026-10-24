/** ClipboardScreen interaction proof: real presses drive the REAL ClipboardApi (core) with a stubbed
 *  desktop session - send, same-time conflict, history apply to both clipboards, incoming clip copy. */
require('./harness');
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const Clipboard = require('expo-clipboard');
const { ClipboardScreen } = require('../dist-test/app/src/screens/ClipboardScreen.js');
const { ClipboardApi } = require('../dist-test/core/src/clipboard.js');

const SUB = '33333333-3333-4333-8333-333333333333';
const ENTRY = { id: '66666666-6666-4666-8666-666666666666', text: 'address from the computer', at: Date.now() - 120000, source: 'pc' };

let calls, eventHandler, writeResult, session, api, renderers;
beforeEach(() => {
  calls = []; writeResult = { status: 'applied', revision: 1 }; renderers = [];
  Clipboard.clipboardText = '';
  session = {
    onEvent: h => { eventHandler = h; return () => {}; },
    onStatus: () => () => {},
    command: async (type, body) => {
      calls.push(`${type}${type === 'clipboard.write' ? ':' + body.text : ''}${type === 'clipboard.apply' ? ':' + body.historyId : ''}`);
      if (type === 'clipboard.subscribe') return { subscriptionId: SUB, revision: 0 };
      if (type === 'clipboard.unsubscribe') return {};
      if (type === 'clipboard.write') return writeResult;
      if (type === 'clipboard.history') return { entries: [ENTRY], nextCursor: null };
      if (type === 'clipboard.apply') return { status: 'applied', revision: 1 };
      throw new Error('unexpected command ' + type);
    },
  };
  api = new ClipboardApi(session);
});
afterEach(() => { for (const r of renderers) r.unmount(); api?.dispose?.(); api = undefined; });

async function mount() {
  let r;
  await act(async () => { r = create(React.createElement(ClipboardScreen, { api, onBack: () => {} })); });
  renderers.push(r);
  return r;
}
const textOf = node => {
  const c = node.props && node.props.children;
  if (c === undefined || c === null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : textOf({ props: { children: x && x.props ? x.props.children : x } }))).join('');
  return textOf({ props: { children: c && c.props ? c.props.children : c } });
};
const allText = r => r.root.findAll(n => typeof n.type === 'string').map(textOf).join('|');
const pressByText = async (r, label) => {
  const target = r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && textOf(n).includes(label))[0];
  assert.ok(target, `no pressable with ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { target.props.onPress(); });
};

test('typed text goes to the computer through the real api, then the field clears', async () => {
  const r = await mount();
  const input = r.root.findByProps({ accessibilityLabel: 'Text to send' });
  await act(async () => { input.props.onChangeText('meet at 7'); });
  await pressByText(r, 'Send');
  assert.ok(calls.includes('clipboard.write:meet at 7'), JSON.stringify(calls));
  assert.ok(allText(r).includes('Sent to your computer'), allText(r).slice(0, 300));
  assert.equal(r.root.findByProps({ accessibilityLabel: 'Text to send' }).props.value, '', 'field cleared after send');
});

test('a same-time conflict keeps the typed text and explains nothing was overwritten', async () => {
  writeResult = { status: 'conflict', revision: 1 };
  const r = await mount();
  const input = r.root.findByProps({ accessibilityLabel: 'Text to send' });
  await act(async () => { input.props.onChangeText('meet at 7'); });
  await pressByText(r, 'Send');
  assert.ok(allText(r).includes('The computer copied something at the same time. Nothing was overwritten.'), allText(r).slice(0, 400));
  assert.equal(r.root.findByProps({ accessibilityLabel: 'Text to send' }).props.value, 'meet at 7', 'conflict never discards what the owner typed');
});

test('a history entry lands on both clipboards: applied on the computer, set on this phone', async () => {
  const r = await mount();
  await pressByText(r, 'address from the computer');
  await act(async () => { await new Promise(res => setImmediate(res)); }); // apply() round-trips before the phone clipboard is set
  assert.ok(calls.includes('clipboard.apply:' + ENTRY.id), JSON.stringify(calls));
  assert.equal(Clipboard.clipboardText, ENTRY.text, 'the phone clipboard holds the exact entry text');
  assert.ok(allText(r).includes('On both clipboards'), allText(r).slice(0, 300));
});

test('an incoming clip from the computer can be copied here, then the banner is dismissed', async () => {
  const r = await mount();
  await act(async () => { eventHandler({ eventType: 'clipboard.changed', data: { subscriptionId: SUB, revision: 1, text: 'otp 493812' } }); });
  assert.ok(allText(r).includes('otp 493812'), 'the incoming clip is shown: ' + allText(r).slice(0, 300));
  await pressByText(r, 'Copy');
  assert.equal(Clipboard.clipboardText, 'otp 493812');
  assert.ok(allText(r).includes('Copied to this phone'), allText(r).slice(0, 300));
  assert.ok(!allText(r).includes('otp 493812') || allText(r).indexOf('otp 493812') > allText(r).indexOf('Copied to this phone'), 'banner dismissed');
});

test('paste-and-send with an empty phone clipboard says so and sends nothing', async () => {
  const r = await mount();
  await pressByText(r, 'Paste');
  assert.ok(allText(r).includes('Your phone clipboard has no text'), allText(r).slice(0, 300));
  assert.deepEqual(calls.filter(c => c.startsWith('clipboard.write')), [], JSON.stringify(calls));
});
