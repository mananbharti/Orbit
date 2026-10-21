import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { describeError } from '../src/messages.js';
import { PairingError } from '../src/pairing.js';
import { CommandError, NotSent, OutcomeUnknown } from '../src/session.js';

test('known desktop codes become actionable sentences', () => {
  assert.match(describeError(new CommandError('AGENT_PAUSED')), /Resume/);
  assert.match(describeError(new CommandError('SCOPE_DENIED')), /Pair again/);
});
test('unknown codes and unknown errors never leak raw text', () => {
  assert.equal(describeError(new CommandError('COMMAND_FAILED')), 'The computer could not do that.');
  assert.equal(describeError(new Error('ECONNRESET 192.168.1.5 token=abc')), 'Something went wrong.');
  assert.equal(describeError('x'), 'Something went wrong.');
});
test('unknown outcome tells the user to check before retrying', () => {
  assert.match(describeError(new OutcomeUnknown()), /Check the task list/);
});
test('local validation messages are shown as written', () => {
  assert.equal(describeError(new NotSent('That request is too long')), 'That request is too long');
  assert.match(describeError(new PairingError('expired', 'This pairing code has expired')), /expired/);
  assert.match(describeError(new InvalidDesktopReply()), /Update Orbit/);
});
test('the codes a person can act on have their own sentence, never the generic one or a raw code', () => {
  const generic = describeError(new CommandError('COMMAND_FAILED'));
  for (const code of ['BIOMETRIC_REQUIRED', 'INPUT_UNAVAILABLE', 'INPUT_SESSION_REQUIRED', 'CLIPBOARD_UNAVAILABLE', 'FILE_QUOTA', 'FILE_IO',
    'FILE_INTEGRITY', 'FILE_SOURCE_CHANGED', 'FILE_NOT_FOUND', 'FILE_EXPIRED', 'FILE_INVALID_STATE']) {
    const text = describeError(new CommandError(code as 'FILE_IO'));
    assert.notEqual(text, generic, code);
    assert.ok(!/[A-Z]{3,}_[A-Z]/.test(text), `${code}: ${text}`);
    assert.ok(text.length < 100 && text.endsWith('.'), `${code}: ${text}`);
  }
});
