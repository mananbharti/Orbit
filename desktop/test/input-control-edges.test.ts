/** Verifies the sequence-counter ceiling edge the main suite leaves open: at the safe-integer limit the session refuses instead of overflowing; depends on synthetic adapters only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import type { CommandContext } from '../src/command-router/command-context.js';
import { InputControlSession } from '../src/input-simulation/control-session.js';
import type { InputSessionAdapter } from '../src/os-integration/input-session.js';

class FakeAdapter implements InputSessionAdapter {
  async open(_signal: AbortSignal): Promise<void> {}
  async releaseAll(): Promise<void> {}
  async dispose(): Promise<void> {}
}
function peer(): CommandContext {
  const closed = new AbortController();
  return { requestId: randomUUID(),
    session: { deviceId: randomUUID(), sessionId: randomUUID(), expiresAt: Date.now() + 60_000 },
    connection: { id: randomUUID(), closed: closed.signal, isAuthorized: () => true, publish: () => {} } };
}

test('the sequence counter refuses the safe-integer ceiling instead of overflowing', async () => {
  const guard = new InputControlSession(() => new FakeAdapter(), new ActivityLog(), { verify: async () => true });
  const context = peer();
  const { controlSessionId } = await guard.begin(context);
  (guard as unknown as { lease: { sequence: number } }).lease.sequence = Number.MAX_SAFE_INTEGER;
  let ran = false;
  await assert.rejects(guard.execute(context, controlSessionId, Number.MAX_SAFE_INTEGER, async () => { ran = true; }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'INPUT_SEQUENCE');
  assert.equal(ran, false, 'no native work happens at the ceiling');
  await guard.stop();
});
