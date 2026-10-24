/** TasksScreen interaction proof: real typing and presses drive the REAL TaskStore (core) with a stubbed
 *  desktop API - submit with and without answer-only, offline gating, attention banner, safe-mode pause/resume. */
require('./harness');
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { TasksScreen } = require('../dist-test/app/src/screens/TasksScreen.js');
const { TaskStore } = require('../dist-test/core/src/task-store.js');

const T1 = '11111111-1111-4111-8111-111111111111';
const task = (state, updatedAt = 1) => ({ taskId: T1, state, createdAt: 0, updatedAt, headline: 'Clean up temp files' });

let api, store, alerts, renderers, opened, dictation;
beforeEach(() => {
  alerts = []; renderers = []; opened = [];
  rn.Alert.alert = (title, message, buttons) => { alerts.push({ title, message, buttons }); };
  api = {
    tasks: [task('awaiting-approval')],
    calls: [],
    async list() { return api.tasks; },
    async submit(prompt, _idem, options) { api.calls.push(`submit:${prompt}:${options?.answerOnly === true}`); const t = { taskId: '55555555-5555-4555-8555-555555555555', state: 'running', createdAt: 2, updatedAt: 2, headline: prompt }; api.tasks = [t, ...api.tasks]; return t; },
    async events() { return []; },
    async status() { return { paused: api.paused === true, answerOnly: true }; },
    async pause() { api.calls.push('pause'); api.paused = true; return { paused: true }; },
    async resume() { api.calls.push('resume'); api.paused = false; return { paused: false }; },
  };
  dictation = { state: { state: 'ready' }, setupState: async () => ({ state: 'ready' }), transcribe: async () => ({ status: 'idle' }), transcribeCompressed: async () => ({ status: 'idle' }) };
});
const freshStore = (status = 'connected') => { store = new TaskStore({ status, onEvent: () => () => {}, onStatus: () => () => {} }, api); };
afterEach(() => { for (const r of renderers) r.unmount(); store?.dispose(); store = undefined; });

const mountWith = async (props = {}) => {
  let r;
  await act(async () => { r = create(React.createElement(TasksScreen, {
    store, api, dictation, name: 'Manan’s Mac',
    onOpen: t => opened.push(t), onRepair: () => {}, onActivity: () => {}, onApps: () => {}, onClipboard: () => {}, onFiles: () => {},
    onRemote: () => {}, onPresent: () => {}, onMemory: () => {}, onControl: () => {}, onSettings: () => {}, ...props })); });
  renderers.push(r);
  return r;
};
const textOf = node => {
  const c = node.props && node.props.children;
  if (c === undefined || c === null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : textOf({ props: { children: x && x.props ? x.props.children : x } }))).join('');
  return textOf({ props: { children: c && c.props ? c.props.children : c } });
};
const allText = r => r.root.findAll(n => typeof n.type === 'string').map(textOf).join('|');
const pressLabel = async (r, label) => {
  const target = r.root.findAll(n => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  assert.ok(target, `no pressable labelled ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { target.props.onPress(); });
  return target;
};
const pressText = async (r, label) => {
  const target = r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && textOf(n).includes(label))[0];
  assert.ok(target, `no pressable with text ${label}: ` + allText(r).slice(0, 400));
  await act(async () => { target.props.onPress(); });
};
const typeTask = async (r, text) => {
  const input = r.root.findByProps({ accessibilityLabel: 'Describe a task' });
  await act(async () => { input.props.onChangeText(text); });
  return input;
};

test('typing a task and pressing Send submits it through the real store and clears the input', async () => {
  freshStore();
  const r = await mountWith();
  const input = await typeTask(r, 'clean the downloads folder');
  await pressLabel(r, 'Send task');
  assert.ok(api.calls.includes('submit:clean the downloads folder:false'), JSON.stringify(api.calls));
  assert.equal(r.root.findByProps({ accessibilityLabel: 'Describe a task' }).props.value, '', 'input cleared after send');
  assert.ok(allText(r).includes('clean the downloads folder'), 'the new task is listed: ' + allText(r).slice(0, 300));
});

test('the answer-only toggle applies to exactly one submission, then resets', async () => {
  freshStore();
  const r = await mountWith();
  await pressLabel(r, 'Answer only, no actions');
  await typeTask(r, 'what is on my desktop');
  await pressLabel(r, 'Send task');
  assert.ok(api.calls.includes('submit:what is on my desktop:true'), JSON.stringify(api.calls));
  await typeTask(r, 'now actually do it');
  await pressLabel(r, 'Send task');
  assert.ok(api.calls.includes('submit:now actually do it:false'), 'the toggle reset after one send: ' + JSON.stringify(api.calls));
});

test('offline, the composer explains and Send stays inert - nothing is submitted', async () => {
  freshStore('searching');
  const r = await mountWith();
  assert.ok(allText(r).includes('Looking for your computer on this network'), allText(r).slice(0, 300));
  await typeTask(r, 'clean the downloads folder');
  const sendBtn = r.root.findAll(n => n.props && n.props.accessibilityLabel === 'Send task')[0];
  assert.equal(sendBtn.props.disabled, true, 'Send is disabled while offline');
  await act(async () => { sendBtn.props.onPress(); });
  assert.deepEqual(api.calls.filter(c => c.startsWith('submit')), [], 'no submission left the phone: ' + JSON.stringify(api.calls));
});

test('the attention banner names the count and opens the exact waiting task', async () => {
  freshStore();
  const r = await mountWith();
  assert.ok(allText(r).includes('1 task needs you'), allText(r).slice(0, 400));
  await pressText(r, '1 task needs you');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].taskId, T1, 'opens the exact task that needs the owner');
  assert.equal(opened[0].state, 'awaiting-approval');
});

test('Stop agent asks first; only the destructive confirm pauses, and resume comes back', async () => {
  freshStore();
  const r = await mountWith();
  await pressText(r, 'Stop agent');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Stop the agent?');
  assert.deepEqual(api.calls.filter(c => c === 'pause'), [], 'nothing paused before the owner confirms');
  const destructive = alerts[0].buttons.find(b => b.style === 'destructive');
  assert.equal(destructive.text, 'Stop agent');
  await act(async () => { destructive.onPress(); });
  assert.ok(api.calls.includes('pause'), JSON.stringify(api.calls));
  assert.ok(allText(r).includes('Agent stopped. Tap to resume.'), allText(r).slice(0, 400));
  await pressText(r, 'Agent stopped. Tap to resume.');
  assert.ok(api.calls.includes('resume'), JSON.stringify(api.calls));
});
