/** The activity log is bounded, metadata-only, and cannot be altered through a snapshot. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';

test('only the newest events up to the capacity are kept, oldest dropped first', () => {
  const log = new ActivityLog(3);
  const types = ['pairing.completed', 'pairing.rejected', 'connection.closed', 'command.completed', 'clipboard.changed', 'terminal.started'] as const;
  for (const eventType of types) log.record({ severity: 'info', eventType, outcome: 'success' });
  assert.deepEqual(log.snapshot().map(e => e.eventType), ['command.completed', 'clipboard.changed', 'terminal.started']);
});

test('extra properties passed by a careless caller never become log data', () => {
  const log = new ActivityLog();
  log.record({ severity: 'warn', eventType: 'pairing.rejected', outcome: 'failed', text: 'secret clipboard', payload: { token: 'abc' } } as never);
  const [entry] = log.snapshot();
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), ['commandType', 'deviceId', 'eventType', 'outcome', 'requestId', 'sessionId', 'severity', 'timestamp']);
  assert.ok(!JSON.stringify(entry).includes('secret') && !JSON.stringify(entry).includes('abc'));
});

test('changing a snapshot never changes the log', () => {
  const log = new ActivityLog();
  log.record({ severity: 'info', eventType: 'pairing.completed', outcome: 'success' });
  const snap = log.snapshot() as unknown as { eventType: string }[];
  snap[0]!.eventType = 'tampered';
  snap.push({ eventType: 'forged' } as never);
  assert.deepEqual(log.snapshot().map(e => e.eventType), ['pairing.completed']);
});

test('timestamps come from the injected clock and an invalid capacity is refused', () => {
  const log = new ActivityLog(5, () => Date.UTC(2026, 9, 21, 12, 0, 0));
  log.record({ severity: 'info', eventType: 'pairing.completed', outcome: 'success' });
  assert.equal(log.snapshot()[0]!.timestamp, '2026-10-21T12:00:00.000Z');
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => new ActivityLog(bad), /Invalid log capacity/);
});

test('onRecord fires for each recorded event with a detached copy', () => {
  const log = new ActivityLog();
  const seen: string[] = [];
  log.onRecord = event => { seen.push(event.eventType); event.eventType = 'tampered' as never; };
  log.record({ severity: 'info', eventType: 'file.state', outcome: 'success' });
  assert.deepEqual(seen, ['file.state']);
  assert.deepEqual(log.snapshot().map(e => e.eventType), ['file.state']);
});

test('a throwing onRecord listener never breaks recording', () => {
  const log = new ActivityLog();
  log.onRecord = () => { throw new Error('listener exploded'); };
  log.record({ severity: 'info', eventType: 'connection.opened', outcome: 'success' });
  assert.equal(log.snapshot().length, 1);
});
