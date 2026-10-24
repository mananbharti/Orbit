/** DevicesScreen interaction proof: permission editing and unpairing are security-sensitive, so tests use
 *  the REAL DevicesApi with a stubbed session - scope toggles send exact lists and roll back on failure,
 *  and both destructive paths ask first. */
require('./harness');
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { DevicesScreen } = require('../dist-test/app/src/screens/DevicesScreen.js');
const { DevicesApi } = require('../dist-test/core/src/devices.js');
const { CommandError } = require('../dist-test/core/src/session.js');

const SELF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = () => [
  { deviceId: SELF, scopes: 'all' },
  { deviceId: OTHER, scopes: ['agent', 'clipboard'] },
];

let calls, alerts, session, api, renderers, failNext;
beforeEach(() => {
  calls = []; alerts = []; renderers = []; failNext = false;
  rn.Alert.alert = (title, message, buttons) => { alerts.push({ title, message, buttons }); };
  session = {
    onEvent: () => () => {},
    onStatus: () => () => {},
    command: async (type, body) => {
      calls.push(`${type}${body.deviceId ? ':' + body.deviceId.slice(0, 8) : ''}${body.scopes ? ':' + JSON.stringify(body.scopes) : ''}`);
      if (failNext) { failNext = false; throw new CommandError('UNAUTHENTICATED'); }
      if (type === 'pair.devices') return { current: SELF, devices: base() };
      if (type === 'pair.scopes.set') return { current: SELF, devices: [{ deviceId: SELF, scopes: 'all' }, { deviceId: OTHER, scopes: body.scopes === 'all' ? 'all' : body.scopes }] };
      if (type === 'pair.revoke') return { current: SELF, devices: [{ deviceId: SELF, scopes: 'all' }] };
      throw new Error('unexpected command ' + type);
    },
  };
  api = new DevicesApi(session);
});
afterEach(() => { for (const r of renderers) r.unmount(); api = undefined; });

async function mount(props = {}) {
  let r;
  await act(async () => { r = create(React.createElement(DevicesScreen, { api, onBack: () => {}, ...props })); });
  await act(async () => { await new Promise(res => setImmediate(res)); });
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
const pressText = async (r, label) => {
  const target = r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && textOf(n).includes(label))[0];
  assert.ok(target, `no pressable with ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { target.props.onPress(); });
};
const scopeSwitch = (r, label) => {
  const row = r.root.findAll(n => n.props && typeof n.props.onValueChange === 'function')
    .map(sw => ({ sw, parent: sw })).map(x => x.sw);
  return row;
};

test('this phone and other devices render with honest access summaries', async () => {
  const r = await mount();
  const text = allText(r);
  assert.ok(text.includes('THIS PHONE') && text.includes('Full access'), text.slice(0, 300));
  assert.ok(text.includes('OTHER DEVICES') && text.includes(`Device ${OTHER.slice(0, 8)}`), text.slice(0, 400));
  assert.ok(text.includes('Limited to 2 permissions'), text.slice(0, 400));
});

test('toggling a scope sends the exact new list through the real api', async () => {
  const r = await mount();
  await pressText(r, `Device ${OTHER.slice(0, 8)}`);
  const sws = r.root.findAll(n => n.props && typeof n.props.onValueChange === 'function');
  // full-access switch first, then one switch per scope label in order
  const filesSwitch = sws[1 + 2]; // agent, clipboard, files -> files is the third label
  assert.equal(filesSwitch.props.value, false, 'Files starts off for this device');
  await act(async () => { filesSwitch.props.onValueChange(true); });
  await act(async () => { await new Promise(res => setImmediate(res)); });
  assert.ok(calls.some(c => c.startsWith('pair.scopes.set:bbbbbbbb') && c.includes('files') && c.includes('agent') && c.includes('clipboard')), JSON.stringify(calls));
});

test('a failed scope change rolls the switch back and says why', async () => {
  const r = await mount();
  await pressText(r, `Device ${OTHER.slice(0, 8)}`);
  failNext = true;
  const sws = r.root.findAll(n => n.props && typeof n.props.onValueChange === 'function');
  await act(async () => { sws[1].props.onValueChange(false); }); // turn Assistant off
  await act(async () => { await new Promise(res => setImmediate(res)); await new Promise(res => setImmediate(res)); });
  const after = r.root.findAll(n => n.props && typeof n.props.onValueChange === 'function');
  assert.equal(after[1].props.value, true, 'the switch is back to the real state after the refusal');
  assert.ok(allText(r).includes('This phone is not signed in to the computer. Pair again.'), allText(r).slice(0, 400));
});

test('unpairing this iPhone asks first; only the destructive confirm revokes and hands back', async () => {
  let unpaired = false;
  const r = await mount({ onUnpairSelf: () => { unpaired = true; } });
  await pressText(r, 'Unpair this iPhone');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Unpair this iPhone?');
  assert.deepEqual(calls.filter(c => c.startsWith('pair.revoke')), [], 'nothing revoked before confirm');
  const destructive = alerts[0].buttons.find(b => b.style === 'destructive');
  await act(async () => { destructive.onPress(); await new Promise(res => setImmediate(res)); });
  assert.ok(calls.some(c => c === 'pair.revoke:' + SELF.slice(0, 8)), JSON.stringify(calls));
  assert.equal(unpaired, true, 'the app returns to pairing after the revoke');
});

test('forgetting another device asks first and removes it from the list', async () => {
  const r = await mount();
  await pressText(r, `Device ${OTHER.slice(0, 8)}`);
  await pressText(r, 'Forget this device');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Forget this device?');
  const destructive = alerts[0].buttons.find(b => b.style === 'destructive');
  await act(async () => { destructive.onPress(); await new Promise(res => setImmediate(res)); await new Promise(res => setImmediate(res)); });
  assert.ok(calls.some(c => c === 'pair.revoke:' + OTHER.slice(0, 8)), JSON.stringify(calls));
  assert.ok(allText(r).includes('No other devices are paired'), 'the forgotten device is gone: ' + allText(r).slice(0, 400));
});
