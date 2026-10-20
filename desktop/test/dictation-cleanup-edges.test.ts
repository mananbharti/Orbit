/** Transcript cleanup edge cases: Unicode, regex-looking dictionary keys, disabled filler removal and idempotence. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTranscript } from '../src/dictation/cleanup.js';

test('fillers are kept when removal is switched off and never cut out of other words', () => {
  assert.equal(cleanTranscript('um send it', { removeFillers: false }), 'Um send it');
  assert.equal(cleanTranscript('ahead of the herd, errand hummus'), 'Ahead of the herd, errand hummus');
});

test('dictionary keys with regex characters match literally and blank keys are ignored', () => {
  const dictionary = { 'c++': 'C plus plus', '': 'x', '  ': 'y', 'a.b': 'dot' };
  assert.equal(cleanTranscript('learn c++ today', { dictionary }), 'Learn C plus plus today');
  assert.equal(cleanTranscript('axb is not a.b', { dictionary }), 'Axb is not dot');
});

test('Devanagari words next to fillers and decomposed characters are handled', () => {
  assert.equal(cleanTranscript('um कल आना'), 'कल आना');
  assert.equal(cleanTranscript('cafe\u0301 uh open'), 'Caf\u00e9 open');
});

test('cleaning already clean text changes nothing', () => {
  const once = cleanTranscript('um hello ,world . ok  then');
  assert.equal(cleanTranscript(once), once);
});
