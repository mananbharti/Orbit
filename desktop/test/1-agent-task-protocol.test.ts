import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { submitTaskSchema, taskEventsPageSchema, taskStateSchema } from '../src/protocol/agent-task.js';

test('submit accepts a normal prompt and rejects oversize, empty and extra fields', () => {
  const idempotencyKey = randomUUID();
  assert.ok(submitTaskSchema.safeParse({ prompt: 'Summarize my downloads', idempotencyKey }).success);
  assert.ok(!submitTaskSchema.safeParse({ prompt: '', idempotencyKey }).success);
  assert.ok(!submitTaskSchema.safeParse({ prompt: 'x'.repeat(8_193), idempotencyKey }).success);
  assert.ok(!submitTaskSchema.safeParse({ prompt: 'ok', idempotencyKey, admin: true }).success);
  assert.ok(!submitTaskSchema.safeParse({ prompt: 'a\0b', idempotencyKey }).success);
});

test('states and event pages are bounded', () => {
  assert.ok(taskStateSchema.safeParse('awaiting-approval').success);
  assert.ok(!taskStateSchema.safeParse('done').success);
  const events = Array.from({ length: 65 }, (_, i) => ({ seq: i + 1, at: 0, kind: 'step', text: 't' }));
  assert.ok(!taskEventsPageSchema.safeParse({ events, hasMore: false }).success);
});
