/** ComputersScreen interaction proof: switching computers, and the two-tap forget that arms, confirms,
 *  and disarms itself - destructive removal is never one accidental tap. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { ComputersScreen } = require('../dist-test/app/src/screens/ComputersScreen.js');

const MAC = { desktopServiceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Manan’s Mac' };
const MINI = { desktopServiceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Office Mini' };

function mount(props = {}) {
  const calls = [];
  let r;
  return (async () => {
    await act(async () => { r = create(React.createElement(ComputersScreen, {
      list: [MAC, MINI], activeId: MAC.desktopServiceId,
      onSwitch: id => calls.push(`switch:${id.slice(0, 8)}`), onAdd: () => calls.push('add'),
      onForget: id => calls.push(`forget:${id.slice(0, 8)}`), onBack: () => {}, ...props })); });
    return { r, calls };
  })();
}
const textOf = node => {
  const c = node.props && node.props.children;
  if (c === undefined || c === null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : textOf({ props: { children: x && x.props ? x.props.children : x } }))).join('');
  return textOf({ props: { children: c && c.props ? c.props.children : c } });
};
const allText = r => r.root.findAll(n => typeof n.type === 'string').map(textOf).join('|');
const pressText = async (r, label, occurrences = 1) => {
  const all = r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && textOf(n).includes(label));
  const exact = all.filter(n => textOf(n) === label); // the leaf button, not the row containing it
  const targets = exact.length ? exact : all;
  assert.ok(targets.length >= occurrences, `no pressable with ${label}: ` + allText(r).slice(0, 400));
  for (const t of targets.slice(0, occurrences)) await act(async () => { t.props.onPress(); });
};

test('the active computer is marked and its row does not switch again', async () => {
  const { r, calls } = await mount();
  assert.ok(allText(r).includes('✓'), 'the active computer is marked');
  const selected = r.root.findAll(n => n.props && n.props.accessibilityState && n.props.accessibilityState.selected === true && n.props.disabled === true);
  assert.ok(selected.length >= 1, 'the active row is selected and inert (disabled while active)');
  r.unmount();
});

test('tapping another computer switches to exactly it', async () => {
  const { r, calls } = await mount();
  await pressText(r, 'Office Mini');
  assert.deepEqual(calls, ['switch:bbbbbbbb'], JSON.stringify(calls));
  r.unmount();
});

test('while a switch is in flight every row is inert', async () => {
  const { r, calls } = await mount({ switchingId: MINI.desktopServiceId });
  assert.ok(allText(r).includes('Switching...'), allText(r).slice(0, 300));
  const rows = r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && n.props.disabled === true && textOf(n).includes('Office Mini'));
  assert.ok(rows.length >= 1, 'the switching row is disabled while the switch is in flight');
  assert.deepEqual(calls, [], 'no switch left the phone: ' + JSON.stringify(calls));
  r.unmount();
});

test('forgetting is two deliberate taps: arm, confirm, never one accident', async () => {
  const { r, calls } = await mount();
  await pressText(r, 'Forget', 1);
  assert.ok(allText(r).includes('Tap again to forget'), 'the first tap only arms: ' + allText(r).slice(0, 300));
  assert.deepEqual(calls, [], 'nothing forgotten yet');
  await pressText(r, 'Tap again to forget', 1);
  assert.deepEqual(calls, ['forget:aaaaaaaa'], JSON.stringify(calls));
  r.unmount();
});

test('an armed forget disarms itself after three seconds', async () => {
  const { r, calls } = await mount();
  await pressText(r, 'Forget', 1);
  assert.ok(allText(r).includes('Tap again to forget'));
  await act(async () => { await new Promise(res => setTimeout(res, 3300)); });
  assert.ok(!allText(r).includes('Tap again to forget'), 'the arm expired: ' + allText(r).slice(0, 300));
  await pressText(r, 'Forget', 1);
  assert.deepEqual(calls, [], 'a fresh tap re-arms instead of forgetting: ' + JSON.stringify(calls));
  assert.ok(allText(r).includes('Tap again to forget'));
  r.unmount();
});

test('Add a computer calls onAdd', async () => {
  const { r, calls } = await mount();
  await pressText(r, 'Add a computer');
  assert.deepEqual(calls, ['add'], JSON.stringify(calls));
  r.unmount();
});
