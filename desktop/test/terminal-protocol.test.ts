/** Remote-terminal wire schemas: strict shapes, command and timeout bounds, and output sizes under the message cap. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_MESSAGE_BYTES } from '../src/config.js';
import { MAX_TERMINAL_COMMAND, MAX_TERMINAL_OUTPUT, TERMINAL_CHUNK, TERMINAL_MAX_TIMEOUT_MS,
  terminalExecResultSchema, terminalExecSchema, terminalOutputEventSchema, terminalSessionSchema } from '../src/protocol/terminal.js';

const sessionId = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';

test('exec accepts a bounded command and rejects empty, oversized, extra or non-uuid input', () => {
  assert.ok(terminalExecSchema.safeParse({ sessionId, command: 'dir' }).success);
  assert.ok(terminalExecSchema.safeParse({ sessionId, command: 'x'.repeat(MAX_TERMINAL_COMMAND) }).success);
  for (const bad of [{ sessionId, command: '' }, { sessionId, command: 'x'.repeat(MAX_TERMINAL_COMMAND + 1) },
    { sessionId, command: 'dir', cwd: 'C:\\' }, { sessionId: 'nope', command: 'dir' }, { command: 'dir' }]) {
    assert.equal(terminalExecSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
  }
});

test('timeouts must be whole milliseconds between 1s and the 120s ceiling', () => {
  for (const timeoutMs of [1_000, 60_000, TERMINAL_MAX_TIMEOUT_MS]) assert.ok(terminalExecSchema.safeParse({ sessionId, command: 'a', timeoutMs }).success, String(timeoutMs));
  for (const timeoutMs of [0, 999, TERMINAL_MAX_TIMEOUT_MS + 1, 1500.5, -5, Number.NaN]) assert.equal(terminalExecSchema.safeParse({ sessionId, command: 'a', timeoutMs }).success, false, String(timeoutMs));
});

test('session and result shapes are strict', () => {
  assert.ok(terminalSessionSchema.safeParse({ sessionId }).success);
  assert.equal(terminalSessionSchema.safeParse({ sessionId, extra: 1 }).success, false);
  assert.ok(terminalExecResultSchema.safeParse({ exitCode: null, cwd: 'C:\\', truncated: false, timedOut: true }).success);
  assert.equal(terminalExecResultSchema.safeParse({ exitCode: 1.5, cwd: 'C:\\', truncated: false, timedOut: false }).success, false);
  assert.equal(terminalExecResultSchema.safeParse({ exitCode: 0, cwd: '', truncated: false, timedOut: false }).success, false);
});

test('an output event holds one chunk of a known stream; a chunk and the total stay below the message cap', () => {
  assert.ok(terminalOutputEventSchema.safeParse({ sessionId, stream: 'stdout', data: 'x'.repeat(TERMINAL_CHUNK) }).success);
  assert.equal(terminalOutputEventSchema.safeParse({ sessionId, stream: 'stdout', data: 'x'.repeat(TERMINAL_CHUNK + 1) }).success, false);
  assert.equal(terminalOutputEventSchema.safeParse({ sessionId, stream: 'stdin', data: 'x' }).success, false);
  assert.ok(TERMINAL_CHUNK < MAX_TERMINAL_OUTPUT && MAX_TERMINAL_OUTPUT < MAX_MESSAGE_BYTES);
});
