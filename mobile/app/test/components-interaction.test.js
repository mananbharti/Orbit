/** Shared component proof: every task state has a human label (no raw enum ever reaches the screen),
 *  the back button always says where it goes, and PressableScale passes presses through. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { StatusPill, stateLabel } = require('../dist-test/app/src/components/StatusPill.js');
const { BackButton } = require('../dist-test/app/src/components/BackButton.js');
const { PressableScale } = require('../dist-test/app/src/components/PressableScale.js');

const STATES = ['queued', 'running', 'awaiting-approval', 'paused', 'completed', 'failed', 'cancelled', 'unknown'];

test('every task state has a human label - the raw enum never reaches the screen', () => {
  for (const state of STATES) {
    assert.ok(stateLabel[state], `missing label for ${state}`);
    assert.ok(!stateLabel[state].includes('undefined'), state);
  }
  assert.equal(Object.keys(stateLabel).length, STATES.length, 'no orphan labels');
});

test('the pill reads its label aloud for assistive tech', async () => {
  let r;
  await act(async () => { r = create(React.createElement(StatusPill, { state: 'awaiting-approval' })); });
  const pill = r.root.findAll(n => n.props && typeof n.props.accessibilityLabel === 'string')[0];
  assert.equal(pill.props.accessibilityLabel, 'Status: Needs you');
  const text = [];
  r.root.findAll(n => n.props && typeof n.props.children === 'string').forEach(n => text.push(n.props.children));
  assert.ok(text.includes('Needs you'), JSON.stringify(text));
  r.unmount();
});

test('the back button says where it goes and fires once per tap', async () => {
  const calls = [];
  let r;
  await act(async () => { r = create(React.createElement(BackButton, { onPress: () => calls.push('back'), label: 'Tasks' })); });
  const button = r.root.findAll(n => n.props && n.props.accessibilityLabel === 'Back' && typeof n.props.onPress === 'function')[0];
  const text = [];
  r.root.findAll(n => n.props && typeof n.props.children === 'string').forEach(n => text.push(n.props.children));
  assert.ok(text.includes('Tasks'), JSON.stringify(text));
  await act(async () => { button.props.onPress(); });
  assert.deepEqual(calls, ['back']);
  r.unmount();
});

test('PressableScale renders its children and passes the press through', async () => {
  const calls = [];
  let r;
  await act(async () => {
    r = create(React.createElement(PressableScale, { onPress: () => calls.push('press') },
      React.createElement('Text', null, 'Push me')));
  });
  const text = [];
  r.root.findAll(n => n.props && typeof n.props.children === 'string').forEach(n => text.push(n.props.children));
  assert.ok(text.includes('Push me'), JSON.stringify(text));
  const button = r.root.findAll(n => n.props && typeof n.props.onPress === 'function')[0];
  await act(async () => { button.props.onPress(); });
  assert.deepEqual(calls, ['press']);
  r.unmount();
});
