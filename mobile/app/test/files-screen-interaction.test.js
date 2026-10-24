/** FilesScreen interaction proof: real presses drive the real FileApi through react-test-renderer -
 * offers render, Receive downloads through the real chunked protocol, Cancel and Resume work mid-flight,
 * and a computer refusal becomes a sentence a person can act on. Not SSR markup assertions. */
require('./harness');
const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
rn.Platform.OS = 'ios';
const crypto = require('node:crypto');
const Module = require('module');
const CORE = require('@orbit/core');
const { FileApi, CommandError } = CORE;

const TID = '11111111-1111-4111-8111-111111111111';
const SUB = '33333333-3333-4333-8333-333333333333';
const LEASE = '44444444-4444-4444-8444-444444444444';
const payload = new Uint8Array(1000).map((_, i) => (i * 7) % 251);
const shahex = b => crypto.createHash('sha256').update(b).digest('hex');
const SHA = shahex(payload);
const offer = { transferId: TID, direction: 'to-client', name: 'report.pdf', sizeBytes: payload.length, sha256: SHA, chunkBytes: 32768 };
const transferring = next => ({ manifest: offer, state: 'transferring', nextOffset: next, leaseId: LEASE });

// The app's ../files module needs native APIs; tests substitute an in-memory sink before the screen loads.
let sink;
const inMemorySink = () => ({
  buf: new Uint8Array(0), finalized: false,
  async size() { return this.buf.length; },
  async write(offset, bytes) { const nb = new Uint8Array(offset + bytes.length); nb.set(this.buf); nb.set(bytes, offset); this.buf = nb; },
  async sha256(length) { return shahex(this.buf.subarray(0, length === undefined ? this.buf.length : length)); },
  async finalize() { this.finalized = true; },
  async discard() {},
});
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/(^|[/\\])\.\.[/\\]files$/.test(request)) return { sinkForDownload: () => sink, sourceFromUri: () => { throw new Error('unused'); } };
  return origLoad.call(this, request, parent, isMain);
};
const { FilesScreen } = require('../dist-test/app/src/screens/FilesScreen.js');

let calls, hooks, session, api;
beforeEach(() => {
  calls = []; hooks = {}; sink = inMemorySink();
  session = {
    onEvent: () => () => {},
    command: async (type, body) => {
      calls.push(type);
      if (hooks[type]) return hooks[type](body);
      if (type === 'file.subscribe') return { subscriptionId: SUB };
      if (type === 'file.offers') return { offers: [offer], nextCursor: null };
      if (type === 'file.status') return transferring(0);
      if (type === 'file.resume') return transferring(0);
      if (type === 'file.read') return { transferId: TID, offset: 0, dataBase64: Buffer.from(payload).toString('base64'), sha256: SHA };
      if (type === 'file.ack') return { transferId: TID, nextOffset: payload.length, state: 'transferring' };
      if (type === 'file.finish') return { manifest: offer, state: 'completed', nextOffset: payload.length };
      if (type === 'file.cancel') return {};
      throw new Error('unexpected command ' + type);
    },
  };
  api = new FileApi(session, { uuid: () => TID, sha256Bytes: async b => shahex(b) }, 1);
});

const textOf = node => {
  const c = node.props && node.props.children;
  if (c === undefined || c === null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : textOf({ props: { children: x && x.props ? x.props.children : x } }))).join('');
  return textOf({ props: { children: c && c.props ? c.props.children : c } });
};
const allText = r => r.root.findAll(n => typeof n.type === 'string').map(textOf).join('|');
const pressByText = async (r, label) => {
  const target = r.root.findAll(n => n.props && typeof n.props.onPress === 'function' &&
    (n.props.accessibilityLabel === label || textOf(n).includes(label)))[0];
  assert.ok(target, `no pressable labelled ${label}: ` + allText(r));
  await act(async () => { target.props.onPress(); });
};
async function mount() {
  let r;
  await act(async () => { r = create(React.createElement(FilesScreen, { api, onBack: () => {} })); });
  return r;
}

test('the offered file renders and Receive downloads it through the real protocol, byte-verified', async () => {
  const r = await mount();
  assert.ok(allText(r).includes('report.pdf'), 'the offer is listed: ' + allText(r));
  await pressByText(r, 'Receive report.pdf');
  assert.equal(api.getState().transfer.state, 'completed');
  assert.equal(sink.finalized, true);
  assert.deepEqual(Buffer.from(sink.buf), Buffer.from(payload), 'the received bytes are exactly what the computer sent');
  assert.ok(calls.includes('file.read') && calls.includes('file.finish'), JSON.stringify(calls));
  assert.ok(allText(r).includes('Done'), allText(r));
  r.unmount();
});

test('a refusal from the computer while watching becomes a plain sentence, not a code', async () => {
  hooks['file.subscribe'] = async () => { throw new CommandError('SYSTEM_UNAVAILABLE'); };
  const r = await mount();
  assert.ok(allText(r).includes('The computer could not do that on this system.'), allText(r));
  assert.ok(!allText(r).includes('SYSTEM_UNAVAILABLE'), 'no raw code leaks: ' + allText(r));
  r.unmount();
});

test('Cancel during a live transfer tells the computer and shows Cancelled', async () => {
  let release;
  hooks['file.read'] = () => new Promise(res => { release = () => res({ transferId: TID, offset: 0, dataBase64: Buffer.from(payload).toString('base64'), sha256: SHA }); });
  const r = await mount();
  await pressByText(r, 'Receive report.pdf');
  await act(async () => { await new Promise(res => setImmediate(res)); });
  assert.equal(api.getState().transfer.state, 'offered', 'the download has started and is waiting on the computer');
  await pressByText(r, 'Cancel');
  assert.ok(calls.includes('file.cancel'), 'the computer hears the cancel: ' + JSON.stringify(calls));
  assert.equal(api.getState().transfer.state, 'cancelled');
  await act(async () => { release(); await new Promise(res => setImmediate(res)); }); // let the in-flight read unwind
  assert.equal(api.getState().transfer.state, 'cancelled', 'a late chunk never revives a cancelled transfer');
  r.unmount();
});

test('a dropped connection pauses the transfer and Resume finishes it from the checkpoint', async () => {
  let reads = 0;
  hooks['file.read'] = async () => { reads += 1; if (reads === 1) throw new CommandError('BUSY');
    return { transferId: TID, offset: 0, dataBase64: Buffer.from(payload).toString('base64'), sha256: SHA }; };
  const r = await mount();
  await pressByText(r, 'Receive report.pdf');
  assert.equal(api.getState().transfer.state, 'paused', 'a transient failure pauses instead of failing');
  assert.ok(allText(r).includes('Paused'), allText(r));
  await pressByText(r, 'Resume');
  assert.equal(api.getState().transfer.state, 'completed');
  assert.equal(sink.finalized, true);
  assert.deepEqual(Buffer.from(sink.buf), Buffer.from(payload));
  r.unmount();
});

