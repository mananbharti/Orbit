/** ActivityScreen proof: every audit kind renders the sentence the owner should read (guards the
 *  cross-side audit-kind sync), the empty state is honest, and a failure becomes a plain sentence. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const { ActivityScreen } = require('../dist-test/app/src/screens/ActivityScreen.js');
const { CommandError } = require('../dist-test/core/src/session.js');

const textOf = node => {
  const c = node.props && node.props.children;
  if (c === undefined || c === null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : textOf({ props: { children: x && x.props ? x.props.children : x } }))).join('');
  return textOf({ props: { children: c && c.props ? c.props.children : c } });
};
const allText = r => r.root.findAll(n => typeof n.type === 'string').map(textOf).join('|');
async function mount(api) {
  let r;
  await act(async () => { r = create(React.createElement(ActivityScreen, { api, onBack: () => {} })); });
  await act(async () => { await new Promise(res => setImmediate(res)); });
  return r;
}

test('every audit kind the desktop can record has its own honest sentence', async () => {
  const kinds = ['submitted', 'approval-requested', 'approved', 'denied', 'approval-timeout', 'approval-stacked-refused', 'cancelled-by-user', 'finished', 'paused', 'resumed'];
  const entries = kinds.map((kind, i) => ({ at: 1700000000000 + i * 60000, kind, outcome: kind === 'finished' ? 'completed' : undefined }));
  const r = await mount({ audit: async () => entries });
  const text = allText(r);
  assert.ok(text.includes('You asked the agent to run a task'), text.slice(0, 300));
  assert.ok(text.includes('The agent asked for permission'), text.slice(0, 300));
  assert.ok(text.includes('You approved') && text.includes('You denied'), text.slice(0, 300));
  assert.ok(text.includes('Permission request timed out and was denied'), text.slice(0, 300));
  assert.ok(text.includes('A second permission request on the same task was refused'), text.slice(0, 300));
  assert.ok(text.includes('You cancelled a task'), text.slice(0, 300));
  assert.ok(text.includes('Task ended: completed'), text.slice(0, 300));
  assert.ok(text.includes('You stopped the agent') && text.includes('You resumed the agent'), text.slice(0, 300));
  assert.ok(!text.includes('undefined'), 'no unmapped kind leaks: ' + text.slice(0, 300));
  r.unmount();
});

test('an empty trail says so, and a failure reads as a sentence not a code', async () => {
  const r = await mount({ audit: async () => [] });
  assert.ok(allText(r).includes('Nothing yet.'), allText(r).slice(0, 300));
  r.unmount();
  const r2 = await mount({ audit: async () => { throw new CommandError('UNAUTHENTICATED'); } });
  assert.ok(allText(r2).includes('This phone is not signed in to the computer. Pair again.'), allText(r2).slice(0, 300));
  assert.ok(!allText(r2).includes('UNAUTHENTICATED'), 'no raw code leaks');
  r2.unmount();
});
