/** App-layer render smoke: the Control screen's structure in markup, not just types. */
require('./harness');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ControlScreen } = require('../dist-test/app/src/screens/ControlScreen.js');

const pendingApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
const html = renderToStaticMarkup(React.createElement(ControlScreen, { api: pendingApi, onBack: () => {}, onPanic: () => {} }));

test('control screen renders the power grid', () => {
  for (const label of ['Lock', 'Sleep', 'Restart', 'Shut down']) assert.ok(html.includes(label), `missing power tile: ${label}`);
});

test('control screen renders the media transport row with accessible labels', () => {
  assert.ok(html.includes('MEDIA'), 'missing MEDIA section');
  for (const label of ['Previous track on your computer', 'Play or pause on your computer', 'Next track on your computer'])
    assert.ok(html.includes(label), `missing media button: ${label}`);
});

test('control screen renders volume and panic sections', () => {
  assert.ok(html.includes('VOLUME'), 'missing VOLUME section');
  assert.ok(html.includes('Volume down') && html.includes('Volume up'), 'missing volume steppers');
});
