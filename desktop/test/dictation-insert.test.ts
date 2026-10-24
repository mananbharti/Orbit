/** Verifies confirm-to-target wiring on the phone dictation flow: focus capture at begin, insertOffered honesty, confirmInsert ownership and fixed outcomes, single use; fake insertion only. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import type { CommandConnection, CommandContext } from '../src/command-router/command-context.js';
import type { JsonValue } from '../src/protocol/messages.js';
import { DictationService, type DictationInsertion, type DictationInsertOutcome } from '../src/dictation/dictation-service.js';
import type { FocusHandle } from '../src/dictation/local-insert.js';

function connection(): CommandConnection {
  const abort = new AbortController();
  return { id: Math.random().toString(36).slice(2), closed: abort.signal, isAuthorized: () => !abort.signal.aborted, publish: () => {} };
}
function contextFor(conn: CommandConnection, deviceId = 'phone-1'): CommandContext {
  return { session: { deviceId, sessionId: 'sess-1', expiresAt: Date.now() + 60_000 }, requestId: 'req-1', connection: conn };
}
const pcmChunk = (samples: number): string => { const b = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) b.writeInt16LE(10_000, i * 2); return b.toString('base64'); };

function fixture(t: TestContext, insertion?: DictationInsertion) {
  const registry = new CommandRegistry();
  const service = new DictationService(registry, { transcribe: async () => 'hello orbit' }, new ActivityLog(), () => ({}), 150_000, undefined, insertion);
  t.after(async () => service.stop());
  const handle = (type: string) => {
    const found = registry.get(type);
    assert.ok(found, `${type} is registered`);
    return found;
  };
  return { handle };
}

async function dictateOnce(handle: ReturnType<typeof fixture>['handle'], context: CommandContext): Promise<{ id: string; result: { [key: string]: JsonValue } }> {
  const begun = await handle('dictation.begin').execute({}, context) as { dictationId: string };
  await handle('dictation.chunk').execute({ dictationId: begun.dictationId, offset: 0, dataBase64: pcmChunk(16_000) }, context);
  const result = await handle('dictation.finish').execute({ dictationId: begun.dictationId }, context) as { [key: string]: JsonValue };
  return { id: begun.dictationId, result };
}

const focus: FocusHandle = { id: '101', pid: 4242 };

test('finish offers insertion when focus was captured and confirmInsert inserts once', async t => {
  const inserted: { handle: FocusHandle; text: string }[] = [];
  const insertion: DictationInsertion = { captureFocus: async () => focus, insert: async (h, text) => { inserted.push({ handle: h, text }); return 'inserted'; } };
  const { handle } = fixture(t, insertion);
  const conn = connection();
  const { id, result } = await dictateOnce(handle, contextFor(conn));
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Hello orbit');
  assert.equal(result.insertOffered, true);
  const confirmed = await handle('dictation.insert').execute({ dictationId: id }, contextFor(conn)) as { outcome: DictationInsertOutcome };
  assert.equal(confirmed.outcome, 'inserted');
  assert.deepEqual(inserted, [{ handle: focus, text: 'Hello orbit' }]);
  await assert.rejects(handle('dictation.insert').execute({ dictationId: id }, contextFor(conn)), /INVALID_PAYLOAD/);
});

test('no captured focus or no insertion path means insertion is not offered and confirmInsert answers unavailable', async t => {
  const insertion: DictationInsertion = { captureFocus: async () => undefined, insert: async () => 'inserted' };
  const { handle } = fixture(t, insertion);
  const conn = connection();
  const { id, result } = await dictateOnce(handle, contextFor(conn));
  assert.equal(result.insertOffered, false);
  const confirmed = await handle('dictation.insert').execute({ dictationId: id }, contextFor(conn)) as { outcome: DictationInsertOutcome };
  assert.equal(confirmed.outcome, 'unavailable');

  const plain = fixture(t);
  const conn2 = connection();
  const second = await dictateOnce(plain.handle, contextFor(conn2));
  assert.equal(second.result.insertOffered, false);
  const confirmed2 = await plain.handle('dictation.insert').execute({ dictationId: second.id }, contextFor(conn2)) as { outcome: DictationInsertOutcome };
  assert.equal(confirmed2.outcome, 'unavailable');
});

test('insertion failure categories pass through unchanged', async t => {
  const insertion: DictationInsertion = { captureFocus: async () => focus, insert: async () => 'focus-mismatch' };
  const { handle } = fixture(t, insertion);
  const conn = connection();
  const { id } = await dictateOnce(handle, contextFor(conn));
  const confirmed = await handle('dictation.insert').execute({ dictationId: id }, contextFor(conn)) as { outcome: DictationInsertOutcome };
  assert.equal(confirmed.outcome, 'focus-mismatch');
});

test('confirmInsert is owned by the dictating connection and device', async t => {
  const insertion: DictationInsertion = { captureFocus: async () => focus, insert: async () => 'inserted' };
  const { handle } = fixture(t, insertion);
  const conn = connection();
  const { id } = await dictateOnce(handle, contextFor(conn));
  await assert.rejects(handle('dictation.insert').execute({ dictationId: id }, contextFor(connection())), /INVALID_PAYLOAD/);
  await assert.rejects(handle('dictation.insert').execute({ dictationId: id }, contextFor(conn, 'phone-2')), /INVALID_PAYLOAD/);
  const confirmed = await handle('dictation.insert').execute({ dictationId: id }, contextFor(conn)) as { outcome: DictationInsertOutcome };
  assert.equal(confirmed.outcome, 'inserted');
});

test('cancel after finish wipes the retained transcript', async t => {
  const insertion: DictationInsertion = { captureFocus: async () => focus, insert: async () => 'inserted' };
  const { handle } = fixture(t, insertion);
  const conn = connection();
  const { id } = await dictateOnce(handle, contextFor(conn));
  await handle('dictation.cancel').execute({ dictationId: id }, contextFor(conn));
  await assert.rejects(handle('dictation.insert').execute({ dictationId: id }, contextFor(conn)), /INVALID_PAYLOAD/);
});
