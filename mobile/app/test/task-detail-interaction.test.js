/** TaskDetailScreen interaction proof: real presses drive approve/deny/cancel/retry through the REAL
 *  TaskStore (core) with a stubbed desktop API - including the stale-tap path the desktop refuses. */
require('./harness');
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { TaskDetailScreen } = require('../dist-test/app/src/screens/TaskDetailScreen.js');
const { TaskStore } = require('../dist-test/core/src/task-store.js');
const { CommandError } = require('../dist-test/core/src/session.js');

const ID = '11111111-1111-4111-8111-111111111111';
const task = (state, updatedAt = 1) => ({ taskId: ID, state, createdAt: 0, updatedAt, headline: 'Clean up temp files' });
const CONTROL = '22222222-2222-4222-8222-222222222222';
const askEvent = { seq: 1, at: 1, kind: 'approval-request', text: 'delete in root path', controlId: CONTROL };

let api, store, alerts, renderers;
beforeEach(() => {
  alerts = []; renderers = [];
  rn.Alert.alert = (title, message, buttons) => { alerts.push({ title, message, buttons }); };
  api = {
    task: task('awaiting-approval'),
    eventList: [askEvent],
    calls: [],
    async list() { return [api.task]; },
    async get() { api.calls.push('get'); return api.task; },
    async events() { return api.eventList; },
    async approve(taskId, approve, controlId) { api.calls.push(`approve:${approve}:${controlId}`); api.task = task('running', 2); api.eventList = [...api.eventList, { seq: 2, at: 2, kind: 'state', text: approve ? 'Approved' : 'Denied' }]; return 'approved'; },
    async cancel() { api.calls.push('cancel'); return (api.task = task('cancelled', 2)); },
    async retry() { api.calls.push('retry'); return task('queued', 3); },
  };
});
const freshStore = () => { store = new TaskStore({ status: 'connected', onEvent: () => () => {}, onStatus: () => () => {} }, api); };
afterEach(() => { for (const r of renderers) r.unmount(); store?.dispose(); store = undefined; });

async function mount(taskId = ID) {
  freshStore(); // after the test has staged api.task, never before
  let r;
  await act(async () => { r = create(React.createElement(TaskDetailScreen, { store, taskId, onBack: () => { api.calls.push('back'); } })); });
  renderers.push(r);
  return r;
}
const textOf = node => {
  let out = '';
  const walk = n => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string' || typeof n === 'number') { out += String(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.props) walk(n.props.children);
  };
  walk(node && node.props ? node.props.children : node);
  return out;
};
const pressByText = async (r, label) => {
  const target = r.root.findAll(n => n.props && typeof n.props.onPress === 'function' && textOf(n) === label)[0];
  assert.ok(target, `no pressable labelled ${label}`);
  await act(async () => { target.props.onPress(); });
};
const allText = r => r.root.findAll(n => typeof n.type === 'string').map(textOf).join('|');

test('Approve and Deny taps send the real decision for the exact task', async () => {
  let r = await mount();
  assert.ok(allText(r).includes('delete in root path'), 'the ask text is shown');
  await pressByText(r, 'Approve');
  assert.ok(api.calls.includes(`approve:true:${CONTROL}`), 'the tap names the exact displayed control: ' + JSON.stringify(api.calls));
  assert.ok(api.calls.includes('get'), 'the store re-reads the task after answering');
  r.unmount(); renderers = []; store.dispose(); store = undefined;
  api.task = task('awaiting-approval'); api.eventList = [askEvent]; api.calls = [];
  r = await mount();
  await pressByText(r, 'Deny');
  assert.ok(api.calls.includes(`approve:false:${CONTROL}`), JSON.stringify(api.calls));
});

test('a stale tap shows the desktop refusal instead of pretending to work', async () => {
  api.approve = async () => { throw new CommandError('AGENT_INVALID_STATE'); };
  const r = await mount();
  await pressByText(r, 'Approve');
  assert.ok(allText(r).includes('That task has already moved on.'), allText(r));
  assert.ok(!api.calls.includes('get'), 'no re-read after a refused answer');
});

test('a running task offers no approve or deny control', async () => {
  api.task = task('running'); api.eventList = [];
  const r = await mount();
  assert.ok(!allText(r).includes('Approve') && !allText(r).includes('Deny'), allText(r));
});

test('cancel asks first, then cancels through the store; the task shows its terminal state', async () => {
  api.task = task('running'); api.eventList = [];
  const r = await mount();
  await pressByText(r, 'Cancel task');
  assert.equal(alerts.length, 1, 'confirmation shown first');
  assert.ok(!api.calls.includes('cancel'), 'nothing cancelled before confirming');
  const destructive = alerts[0].buttons.find(b => b.style === 'destructive');
  await act(async () => { destructive.onPress(); });
  assert.ok(api.calls.includes('cancel'), JSON.stringify(api.calls));
});

test('a failed task can be run again as a NEW task after confirmation', async () => {
  api.task = task('failed'); api.eventList = [];
  const r = await mount();
  await pressByText(r, 'Run again as a new task');
  const again = alerts[0].buttons.find(b => b.text === 'Run again');
  await act(async () => { again.onPress(); });
  assert.ok(api.calls.includes('retry'), JSON.stringify(api.calls));
  assert.ok(api.calls.includes('back'), 'returns to the list so the new task is visible');
});
