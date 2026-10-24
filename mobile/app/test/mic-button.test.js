/** App-layer render proof: the dictation setup states are visible and actionable in markup (SSR; wiring effects run on-device only). */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { SetupNotice } = require('../dist-test/app/src/components/MicButton.js');

const noop = () => {};

test('downloading state announces the one-time download and offers a real Cancel', () => {
  const html = renderToStaticMarkup(React.createElement(SetupNotice, { setup: { state: 'downloading' }, onRetry: noop, onCancel: noop }));
  assert.ok(html.includes('Setting up dictation on your computer'), 'missing setup announcement');
  assert.ok(html.includes('Cancel dictation setup'), 'missing accessible cancel');
});

test('failed state says so and offers a real Retry; cancelled reads honestly', () => {
  const failed = renderToStaticMarkup(React.createElement(SetupNotice, { setup: { state: 'failed', reason: 'HASH_MISMATCH' }, onRetry: noop, onCancel: noop }));
  assert.ok(failed.includes('Dictation setup failed'), 'missing failure text');
  assert.ok(failed.includes('Retry dictation setup'), 'missing accessible retry');
  const cancelled = renderToStaticMarkup(React.createElement(SetupNotice, { setup: { state: 'failed', reason: 'cancelled' }, onRetry: noop, onCancel: noop }));
  assert.ok(cancelled.includes('Dictation setup was cancelled'), 'cancelled must not read as a generic failure');
});

test('ready and off states: nothing shown when ready, honest unavailable when off', () => {
  const ready = renderToStaticMarkup(React.createElement(SetupNotice, { setup: { state: 'ready' }, onRetry: noop, onCancel: noop }));
  assert.ok(!ready.includes('dictation') && !ready.includes('Dictation'), 'ready must render no setup chrome');
  const off = renderToStaticMarkup(React.createElement(SetupNotice, { setup: { state: 'off' }, onRetry: noop, onCancel: noop }));
  assert.ok(off.includes('not available'), 'off must say unavailable');
});
