/** SettingsScreen interaction proof: theme radio moves selection and re-themes, the clipboard switch
 *  reports the exact value, the Face ID switch honours the no-biometrics gate, nav rows fire. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { SettingsScreen } = require('../dist-test/app/src/screens/SettingsScreen.js');
const { ThemeProvider } = require('../dist-test/app/src/theme.js');

async function mount(props = {}) {
  const calls = [];
  let r;
  await act(async () => { r = create(React.createElement(ThemeProvider, null, React.createElement(SettingsScreen, {
    name: 'Manan’s Mac', onBack: () => {}, onRepair: () => calls.push('repair'),
    autoSync: true, onAutoSync: v => calls.push(`autoSync:${v}`),
    appLock: false, onAppLock: v => calls.push(`appLock:${v}`),
    biometrics: true, onDevices: () => calls.push('devices'), onComputers: () => calls.push('computers'), ...props }))); });
  return { r, calls };
}
const textOf = node => {
  const c = node.props && node.props.children;
  if (c === undefined || c === null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : textOf({ props: { children: x && x.props ? x.props.children : x } }))).join('');
  return textOf({ props: { children: c && c.props ? c.props.children : c } });
};
const allText = r => r.root.findAll(n => typeof n.type === 'string').map(textOf).join('|');
const radio = (r, label) => r.root.findAll(n => n.props && n.props.accessibilityRole === 'radio' && textOf(n) === label)[0];
const switches = r => r.root.findAll(n => n.props && typeof n.props.onValueChange === 'function');

test('the theme radio moves the selection and the screen actually re-themes', async () => {
  const { r } = await mount();
  assert.equal(radio(r, 'Auto').props.accessibilityState.selected, true, 'Auto selected by default');
  const lightBg = JSON.stringify(r.root.findAll(n => n.props && n.props.style)[0].props.style);
  await act(async () => { radio(r, 'Dark').props.onPress(); });
  assert.equal(radio(r, 'Dark').props.accessibilityState.selected, true, 'Dark selected after the tap');
  assert.equal(radio(r, 'Auto').props.accessibilityState.selected, false);
  const darkBg = JSON.stringify(r.root.findAll(n => n.props && n.props.style)[0].props.style);
  assert.notEqual(darkBg, lightBg, 'the visible theme changed, not just the radio');
  r.unmount();
});

test('the auto-sync switch reports the exact new value', async () => {
  const { r, calls } = await mount({ autoSync: true });
  const sw = switches(r)[0];
  assert.equal(sw.props.value, true);
  await act(async () => { sw.props.onValueChange(false); });
  assert.deepEqual(calls, ['autoSync:false'], JSON.stringify(calls));
  r.unmount();
});

test('without biometrics the Face ID switch is off and disabled, with the honest explanation', async () => {
  const { r, calls } = await mount({ biometrics: false, appLock: true });
  assert.ok(allText(r).includes('This phone has no face or fingerprint enrolled, so Orbit cannot gate the connection.'), allText(r).slice(0, 400));
  const sw = switches(r)[1];
  assert.equal(sw.props.value, false, 'the switch reads off even though appLock was stored on');
  assert.equal(sw.props.disabled, true, 'and it cannot be flipped');
  assert.deepEqual(calls.filter(c => c.startsWith('appLock')), [], 'no appLock call reached the app');
  r.unmount();
});

test('with biometrics the Face ID switch flips and reports', async () => {
  const { r, calls } = await mount({ biometrics: true, appLock: false });
  const sw = switches(r)[1];
  assert.equal(sw.props.disabled, false);
  await act(async () => { sw.props.onValueChange(true); });
  assert.deepEqual(calls, ['appLock:true'], JSON.stringify(calls));
  r.unmount();
});

test('the computer, devices and re-pair rows call their handlers', async () => {
  const { r, calls } = await mount();
  const pressText = async label => {
    const target = r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && textOf(n).includes(label))[0];
    assert.ok(target, `no row for ${label}: ` + allText(r).slice(0, 400));
    await act(async () => { target.props.onPress(); });
  };
  assert.ok(allText(r).includes('Manan’s Mac'), 'the computer name is shown');
  await pressText('Computers');
  await pressText('Devices');
  await pressText('Forget this computer');
  assert.deepEqual(calls, ['computers', 'devices', 'repair'], JSON.stringify(calls));
  r.unmount();
});
