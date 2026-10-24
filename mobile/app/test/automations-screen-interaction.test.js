/** AutomationsScreen interaction proof: the computer runs these on its own clock - what the phone
 *  saves is exactly what the computer will do, so the editor must be exact. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { AutomationsScreen } = require('../dist-test/app/src/screens/AutomationsScreen.js');

const SCENES = [{ id: 'scene-1', name: 'Work' }];
const EXISTING = [{ id: 'auto-1', time: '22:30', days: [1, 2, 3, 4, 5], enabled: true, action: { type: 'power', action: 'sleep' } }];

function fakeApi(overrides = {}) {
  const calls = [];
  return { calls,
    refresh: async () => { calls.push('refresh'); return EXISTING; },
    save: async a => { calls.push(`save:${JSON.stringify(a)}`); return [...EXISTING, { ...a, id: 'auto-2', enabled: true }]; },
    remove: async id => { calls.push(`remove:${id}`); return []; },
    setEnabled: async (id, on) => { calls.push(`setEnabled:${id}:${on}`); return [{ ...EXISTING[0], enabled: on }]; },
    ...overrides };
}
async function mount(api, props = {}) {
  let r;
  await act(async () => { r = create(React.createElement(AutomationsScreen, { api, scenes: SCENES, onBack: () => {}, ...props })); });
  await act(async () => { await new Promise(res => setTimeout(res, 10)); });
  return r;
}
const textOf = (node, depth = 0) => {
  if (depth > 30) return '';
  const c = node.props && node.props.children;
  if (c === null || c === undefined) return '';
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  if (Array.isArray(c)) return c.map(x => textOf({ props: { children: x } }, depth + 1)).join('');
  if (typeof c === 'object') return textOf(c, depth + 1);
  return '';
};
const outermost = nodes => nodes.filter(n => { let p = n.parent; while (p) { if (nodes.includes(p)) return false; p = p.parent; } return true; });
const allText = r => outermost(r.root.findAll(n => typeof n.props === 'object' && n.props && typeof n.props.children !== 'undefined')).map(n => textOf(n)).filter(Boolean).join('|');
const pressLabel = async (r, label) => {
  const t = outermost(r.root.findAll(n => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function'));
  assert.ok(t.length, `no pressable labelled ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { t[0].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};
const pressText = async (r, label) => {
  const t = outermost(r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && textOf(n).includes(label)));
  assert.ok(t.length, `no pressable with ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { t[0].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};

test('the list describes each automation in plain words', async () => {
  const r = await mount(fakeApi());
  const text = allText(r);
  assert.ok(text.includes('22:30'), text.slice(0, 300));
  assert.ok(text.includes('Sleep · Weekdays'), 'action and days in words: ' + text.slice(0, 400));
  r.unmount();
});

test('the switch flips exactly that automation on the computer', async () => {
  const api = fakeApi();
  const r = await mount(api);
  const sw = r.root.findAll(n => n.props && typeof n.props.onValueChange === 'function')[0];
  assert.equal(sw.props.value, true);
  await act(async () => { sw.props.onValueChange(false); await new Promise(res => setTimeout(res, 5)); });
  assert.deepEqual(api.calls.filter(c => c.startsWith('setEnabled')), ['setEnabled:auto-1:false'], JSON.stringify(api.calls));
  r.unmount();
});

test('a new automation defaults to a weekday 9am sleep, and the steppers wrap the clock cleanly', async () => {
  const api = fakeApi();
  const r = await mount(api);
  await pressText(r, 'New automation');
  assert.ok(allText(r).includes('New automation'), allText(r).slice(0, 300));
  assert.ok(allText(r).includes('Weekdays'), 'weekday default: ' + allText(r).slice(0, 400));
  await pressLabel(r, 'Earlier hour');
  await pressLabel(r, 'Earlier hour');
  await pressLabel(r, 'Earlier hour');
  await pressLabel(r, 'Earlier hour');
  await pressLabel(r, 'Earlier hour');
  await pressLabel(r, 'Earlier hour');
  await pressLabel(r, 'Earlier hour');
  await pressLabel(r, 'Earlier hour');
  await pressLabel(r, 'Earlier hour');
  assert.ok(allText(r).includes('00'), 'nine hours earlier than 09: wraps to 00');
  await pressLabel(r, 'Earlier hour');
  assert.ok(allText(r).includes('23'), 'one more earlier wraps 00 to 23');
  await pressLabel(r, 'Later');
  assert.ok(allText(r).includes('05'), 'minutes step in fives');
  await pressText(r, 'Save');
  assert.deepEqual(api.calls.filter(c => c.startsWith('save')),
    ['save:{"time":"23:05","days":[1,2,3,4,5],"action":{"type":"power","action":"sleep"}}'], JSON.stringify(api.calls));
  r.unmount();
});

test('day chips toggle, and the summary keeps up in words', async () => {
  const api = fakeApi({ refresh: async () => [] });
  const r = await mount(api);
  await pressText(r, 'New automation');
  await pressLabel(r, 'Sat');
  assert.ok(allText(r).includes('Mon Tue Wed Thu Fri Sat'), 'Saturday joined: ' + allText(r).slice(0, 400));
  await pressLabel(r, 'Mon');
  assert.ok(allText(r).includes('Tue Wed Thu Fri Sat'), 'Monday left: ' + allText(r).slice(0, 400));
  r.unmount();
});

test('choosing a scene action saves the scene id, not its name', async () => {
  const api = fakeApi({ refresh: async () => [] });
  const r = await mount(api);
  await pressText(r, 'New automation');
  await pressText(r, 'Open Work');
  await pressText(r, 'Save');
  assert.deepEqual(api.calls.filter(c => c.startsWith('save')),
    ['save:{"time":"09:00","days":[1,2,3,4,5],"action":{"type":"scene","sceneId":"scene-1"}}'], JSON.stringify(api.calls));
  r.unmount();
});

test('editing carries the id through save and delete', async () => {
  const api = fakeApi();
  const r = await mount(api);
  await pressText(r, '22:30');
  assert.ok(allText(r).includes('Edit automation'), allText(r).slice(0, 300));
  await pressLabel(r, 'Later hour');
  await pressText(r, 'Save');
  assert.deepEqual(api.calls.filter(c => c.startsWith('save')),
    ['save:{"id":"auto-1","time":"23:30","days":[1,2,3,4,5],"action":{"type":"power","action":"sleep"}}'], JSON.stringify(api.calls));
  await pressText(r, '22:30');
  await pressText(r, 'Delete automation');
  assert.deepEqual(api.calls.filter(c => c.startsWith('remove')), ['remove:auto-1'], JSON.stringify(api.calls));
  r.unmount();
});

test('an empty computer explains what automations are for', async () => {
  const r = await mount(fakeApi({ refresh: async () => [] }));
  assert.ok(allText(r).includes('No automations yet.'), allText(r).slice(0, 400));
  r.unmount();
});
