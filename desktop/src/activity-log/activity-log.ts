/** Keeps bounded operational metadata in memory; depends on ActivityEvent; does not persist or collect payloads. */
import type { ActivityEvent } from './activity-event.js';

export class ActivityLog {
  private readonly events: ActivityEvent[] = [];
  /** Optional sink notified after each recorded event; the shell uses it to refresh views live. Listener errors never break recording. */
  onRecord?: (event: ActivityEvent) => void;
  constructor(private readonly capacity = 1_000, private readonly now = Date.now) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid log capacity');
  }

  record(event: Omit<ActivityEvent, 'timestamp'>): void {
    // Explicit projection prevents extra runtime properties from becoming log data.
    const recorded: ActivityEvent = { timestamp: new Date(this.now()).toISOString(), severity: event.severity,
      eventType: event.eventType, deviceId: event.deviceId, sessionId: event.sessionId,
      requestId: event.requestId, commandType: event.commandType, outcome: event.outcome };
    this.events.push(recorded);
    if (this.events.length > this.capacity) this.events.shift();
    try { this.onRecord?.({ ...recorded }); } catch { /* a listener must never break recording */ }
  }

  snapshot(): readonly ActivityEvent[] { return this.events.map(event => ({ ...event })); }
}
