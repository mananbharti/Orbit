/** MicButton interaction proof: real presses drive the real component through react-test-renderer - setup gating, retry/cancel effects, permission denial, recording, transcription outcomes. Not SSR markup assertions. */
require('./harness');
const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const rn = require('react-native-web');
const audio = require('expo-audio');
rn.Platform.OS = 'ios';
const { MicButton } = require('../dist-test/app/src/components/MicButton.js');

let rec, api, texts, errors;
beforeEach(() => {
  rec = { prepareToRecordAsync: async () => {}, record: () => { rec.recorded = true; }, stop: async () => {}, uri: '/tmp/clip.wav', recorded: false };
  audio.useAudioRecorder = () => rec;
  audio.requestRecordingPermissionsAsync = async () => ({ granted: true });
  api = {
    state: { state: 'ready' },
    setupState: async () => api.state,
    retrySetup: async () => { api.calls.push('retry'); return (api.state = { state: 'downloading' }); },
    cancelSetup: async () => { api.calls.push('cancel'); return (api.state = { state: 'failed', reason: 'cancelled' }); },
    transcribeForInsert: async () => { api.calls.push('transcribe'); return { result: { status: 'text', text: 'hello' } }; },
    transcribeCompressedForInsert: async () => { api.calls.push('transcribeCompressed'); return { result: { status: 'text', text: 'hello' } }; },
    confirmInsert: async id => { api.calls.push('insert:' + id); return 'paste-sent'; },
    discard: async id => { api.calls.push('discard:' + id); },
    calls: [],
  };
  texts = []; errors = [];
});

async function mount() {
  let r;
  await act(async () => { r = create(React.createElement(MicButton, { api, onText: t => texts.push(t), onError: e => errors.push(e) })); });
  return r;
}
const mic = r => r.root.findByProps({ accessibilityLabel: 'Start dictation' });
const byLabel = (r, label) => r.root.findAllByProps({ accessibilityLabel: label })[0];

test('tap while the engine is downloading records nothing and fires no transcription', async () => {
  api.state = { state: 'downloading' };
  const r = await mount();
  await act(async () => { mic(r).props.onPress(); });
  assert.equal(rec.recorded, false);
  assert.deepEqual(api.calls.filter(c => c.startsWith('transcribe')), []);
  assert.deepEqual(texts, []); assert.deepEqual(errors, []);
});

test('Cancel press calls cancelSetup on the computer; Retry press calls retrySetup', async () => {
  api.state = { state: 'downloading' };
  const r = await mount();
  await act(async () => { byLabel(r, 'Cancel dictation setup').props.onPress(); });
  assert.deepEqual(api.calls, ['cancel']);
  api.calls = []; api.state = { state: 'failed', reason: 'HASH_MISMATCH' };
  await act(async () => { byLabel(r, 'Retry dictation setup').props.onPress(); });
  assert.deepEqual(api.calls, ['retry']);
});

test('tap while the engine is off tells the user and never touches the mic', async () => {
  api.state = { state: 'off' };
  const r = await mount();
  await act(async () => { mic(r).props.onPress(); });
  assert.equal(rec.recorded, false);
  assert.deepEqual(errors, ['Dictation is not available on this computer.']);
});

test('denied mic permission asks for the permission and never records', async () => {
  audio.requestRecordingPermissionsAsync = async () => ({ granted: false });
  const r = await mount();
  await act(async () => { mic(r).props.onPress(); });
  assert.equal(rec.recorded, false);
  assert.deepEqual(errors, ['Allow the microphone in Settings to dictate.']);
});

test('tap records, second tap stops and lands transcribed text in the task box', async () => {
  const r = await mount();
  await act(async () => { mic(r).props.onPress(); });
  assert.equal(rec.recorded, true);
  await act(async () => { r.root.findByProps({ accessibilityLabel: 'Stop dictation' }).props.onPress(); });
  assert.deepEqual(api.calls, ['transcribe']);
  assert.deepEqual(texts, ['hello']);
  assert.deepEqual(errors, []);
});

test('silence and unreadable recordings surface honest errors, never fake text', async () => {
  api.transcribeForInsert = async () => ({ result: { status: 'no-speech' } });
  const r = await mount();
  await act(async () => { mic(r).props.onPress(); });
  await act(async () => { r.root.findByProps({ accessibilityLabel: 'Stop dictation' }).props.onPress(); });
  assert.deepEqual(errors, ['I did not hear anything.']);
  assert.deepEqual(texts, []);
  rec.uri = null; rec.recorded = false; errors.length = 0;
  await act(async () => { mic(r).props.onPress(); });
  await act(async () => { r.root.findByProps({ accessibilityLabel: 'Stop dictation' }).props.onPress(); });
  assert.deepEqual(errors, ['That recording could not be read.']);
});

test('an insert offer renders the target, Insert confirms and shows the honest outcome, Not now discards', async () => {
  api.transcribeForInsert = async () => ({ result: { status: 'text', text: 'hello', insertOffered: true, insertTarget: 'Terminal' }, dictationId: 'clip-1' });
  const r = await mount();
  await act(async () => { mic(r).props.onPress(); });   // start
  await act(async () => { r.root.findByProps({ accessibilityLabel: 'Stop dictation' }).props.onPress(); }); // stop
  assert.deepEqual(texts, ['hello']);
  const textOf = node => [node.props && node.props.children].flat(Infinity).join('');
  const offer = r.root.findAll(node => /Also insert into Terminal\?/.test(textOf(node)));
  assert.ok(offer.length >= 1, 'the offer names the captured window');
  await act(async () => { byLabel(r, 'Insert dictated text into the computer window').props.onPress(); });
  assert.deepEqual(api.calls.filter(c => c.startsWith('insert:')), ['insert:clip-1']);
  const notice = r.root.findAll(node => /check that it landed/i.test(textOf(node)));
  assert.ok(notice.length >= 1, 'paste-sent is reported as unverified, not delivered');

  api.transcribeForInsert = async () => ({ result: { status: 'text', text: 'again', insertOffered: true }, dictationId: 'clip-2' });
  await act(async () => { mic(r).props.onPress(); });
  await act(async () => { r.root.findByProps({ accessibilityLabel: 'Stop dictation' }).props.onPress(); });
  await act(async () => { byLabel(r, 'Dismiss insert offer').props.onPress(); });
  assert.deepEqual(api.calls.filter(c => c.startsWith('discard:')), ['discard:clip-2']);
});

test('no insert offer renders no insert row', async () => {
  const r = await mount();
  await act(async () => { mic(r).props.onPress(); });
  await act(async () => { r.root.findByProps({ accessibilityLabel: 'Stop dictation' }).props.onPress(); });
  assert.deepEqual(texts, ['hello']);
  assert.equal(r.root.findAllByProps({ accessibilityLabel: 'Insert dictated text into the computer window' }).length, 0);
});
