/** TerminalScreen interaction proof: sessions are explicit, output streams live, commands hit the
 *  computer verbatim, and a dead session takes the phone back to the start honestly. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { TerminalScreen } = require('../dist-test/app/src/screens/TerminalScreen.js');
const { CommandError } = require('@orbit/core');

function fakeApi(overrides = {}) {
  const calls = [];
  let outputHandler = () => {};
  return { calls,
    emit: (stream, data) => outputHandler(stream, data),
    onOutput: h => { outputHandler = h; calls.push('onOutput'); return () => { calls.push('offOutput'); }; },
    begin: async () => { calls.push('begin'); return { cwd: '/Users/manan' }; },
    exec: async cmd => { calls.push(`exec:${cmd}`); return { cwd: '/Users/manan', exitCode: 0, timedOut: false, truncated: false }; },
    end: async () => { calls.push('end'); },
    interrupt: async () => { calls.push('interrupt'); },
    ...overrides };
}
async function mount(api, props = {}) {
  let r;
  await act(async () => { r = create(React.createElement(TerminalScreen, { api, onBack: () => { api.calls.push('back'); }, ...props })); });
  await act(async () => { await new Promise(res => setTimeout(res, 5)); });
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
const allText = r => outermost(r.root.findAll(n => n.props && typeof n.props.children !== 'undefined')).map(n => textOf(n)).filter(Boolean).join('|');
const pressText = async (r, label) => {
  const t = outermost(r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && textOf(n).includes(label)));
  assert.ok(t.length, `no pressable with ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { t[0].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};
const pressLabel = async (r, label) => {
  const t = outermost(r.root.findAll(n => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function'));
  assert.ok(t.length, `no pressable labelled ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { t[0].props.onPress(); await new Promise(res => setTimeout(res, 5)); });
};
const input = r => r.root.findAll(n => n.type === 'TextInput')[0];

test('a session starts only when asked, and says so', async () => {
  const api = fakeApi();
  const r = await mount(api);
  assert.ok(allText(r).includes("Each session needs a Yes on the computer's screen"), 'the ask is honest up front: ' + allText(r).slice(0, 300));
  await pressText(r, 'Start session');
  assert.deepEqual(api.calls.filter(c => c === 'begin'), ['begin']);
  const text = allText(r);
  assert.ok(text.includes('/Users/manan'), 'cwd shown: ' + text.slice(0, 300));
  assert.ok(text.includes('Session approved.'), text.slice(0, 300));
  r.unmount();
});

test('a refused session explains itself and stays on the start screen', async () => {
  const api = fakeApi({ begin: async () => { throw new Error('RAW SOCKET BLEW UP'); } });
  const r = await mount(api);
  await pressText(r, 'Start session');
  const text = allText(r);
  assert.ok(!text.includes('RAW SOCKET BLEW UP'), 'no raw error leak: ' + text.slice(0, 400));
  assert.ok(text.includes('Start session'), 'still at the start: ' + text.slice(0, 300));
  r.unmount();
});

test('a command goes to the computer verbatim, and its result notes appear', async () => {
  const api = fakeApi({ exec: async cmd => { api.calls.push(`exec:${cmd}`); return { cwd: '/Users/manan/projects', exitCode: 2, timedOut: false, truncated: false }; } });
  const r = await mount(api, { initialState: { cwd: '/Users/manan', lines: [] } });
  await act(async () => { input(r).props.onChangeText('  cd projects && ls  '); });
  await act(async () => { input(r).props.onSubmitEditing(); await new Promise(res => setTimeout(res, 5)); });
  assert.deepEqual(api.calls.filter(c => c.startsWith('exec')), ['exec:cd projects && ls'], 'trimmed, otherwise verbatim: ' + JSON.stringify(api.calls));
  const text = allText(r);
  assert.ok(text.includes('$ cd projects && ls'), 'the command echoes: ' + text.slice(0, 400));
  assert.ok(text.includes('(exit code 2)'), 'the failure is visible: ' + text.slice(0, 400));
  assert.ok(text.includes('/Users/manan/projects'), 'the cwd follows the command: ' + text.slice(0, 400));
  assert.equal(input(r).props.value, '', 'the field clears for the next command');
  r.unmount();
});

test('streamed output lands line by line, carriage returns stripped, capped at 500 lines', async () => {
  const api = fakeApi();
  const r = await mount(api, { initialState: { cwd: '/tmp', lines: [] } });
  await act(async () => { api.emit('stdout', 'one\r\ntwo\r\nthree'); });
  const text = allText(r);
  assert.ok(text.includes('one') && text.includes('two') && text.includes('three'), text.slice(0, 400));
  assert.ok(!text.includes('\r'), 'no carriage returns');
  await act(async () => { api.emit('stdout', Array.from({ length: 600 }, (_, i) => `line-${i}`).join('\n')); });
  const rendered = outermost(r.root.findAll(n => n.props && typeof n.props.children === 'string' && n.props.children.startsWith('line-')));
  assert.ok(rendered.length <= 500, `capped: ${rendered.length}`);
  assert.ok(allText(r).includes('line-599'), 'the newest lines survive the cap');
  r.unmount();
});

test('a dead session takes the phone back to the start, honestly', async () => {
  const api = fakeApi({ exec: async () => { throw new CommandError('TERMINAL_SESSION_REQUIRED', 'session required'); } });
  const r = await mount(api, { initialState: { cwd: '/tmp', lines: [] } });
  await act(async () => { input(r).props.onChangeText('ls'); });
  await act(async () => { input(r).props.onSubmitEditing(); await new Promise(res => setTimeout(res, 5)); });
  const text = allText(r);
  assert.ok(text.includes('Start session'), 'back at the start: ' + text.slice(0, 400));
  r.unmount();
});

test('while a command runs, the send button becomes a stop that interrupts', async () => {
  let release;
  const api = fakeApi({ exec: async cmd => { api.calls.push(`exec:${cmd}`); await new Promise(res => { release = res; }); return { cwd: '/tmp', exitCode: 0 }; } });
  const r = await mount(api, { initialState: { cwd: '/tmp', lines: [] } });
  await act(async () => { input(r).props.onChangeText('sleep 60'); });
  await act(async () => { input(r).props.onSubmitEditing(); });
  assert.equal(input(r).props.editable, false, 'no typing over a running command');
  await pressLabel(r, 'Stop the running command');
  assert.deepEqual(api.calls.filter(c => c === 'interrupt'), ['interrupt'], JSON.stringify(api.calls));
  await act(async () => { release(); await new Promise(res => setTimeout(res, 5)); });
  assert.equal(input(r).props.editable, true, 'the field is live again');
  r.unmount();
});

test('ending the session closes it on the computer and wipes the scrollback', async () => {
  const api = fakeApi();
  const r = await mount(api, { initialState: { cwd: '/tmp', lines: [{ id: 1, stream: 'cmd', text: 'ls' }] } });
  await pressText(r, 'End session');
  assert.deepEqual(api.calls.filter(c => c === 'end'), ['end'], JSON.stringify(api.calls));
  const text = allText(r);
  assert.ok(text.includes('Start session'), 'back at the start: ' + text.slice(0, 300));
  assert.ok(!text.includes('$ ls'), 'scrollback wiped');
  r.unmount();
});
