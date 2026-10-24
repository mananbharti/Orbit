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
    transcribe: async () => { api.calls.push('transcribe'); return { status: 'text', text: 'hello' }; },
    transcribeCompressed: async () => { api.calls.push('transcribeCompressed'); return { status: 'text', text: 'hello' }; },
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
  api.transcribe = async () => ({ status: 'no-speech' });
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
