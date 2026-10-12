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
  assert.equal(describeError(new CommandError('FILE_IO')), 'The computer could not do that.');
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
