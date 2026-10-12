/** Typed agent task calls over a session; depends on OrbitSession and Zod; does not render UI or keep task state. */
import { MAX_TASK_PROMPT_BYTES, approvalResultSchema, auditPageSchema, type AuditEntry, taskEventsPageSchema, taskListSchema, taskSummarySchema,
  type TaskEvent, type TaskSummary } from './protocol.js';
import { NotSent, type OrbitSession } from './session.js';

export class InvalidDesktopReply extends Error {
  constructor() { super('Desktop sent an unexpected reply'); }
}
const check = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw new InvalidDesktopReply();
  return r.data;
};

export class AgentApi {
  constructor(private readonly session: OrbitSession, private readonly uuid: () => string) {}

  /** Pass the same idempotencyKey when retrying after OutcomeUnknown so the desktop never starts the task twice. */
  async submit(prompt: string, idempotencyKey: string = this.uuid()): Promise<TaskSummary> {
    const text = prompt.trim();
    if (!text) throw new NotSent('Write what you want the agent to do');
    if (new TextEncoder().encode(text).length > MAX_TASK_PROMPT_BYTES) throw new NotSent('That request is too long');
    return check(taskSummarySchema, await this.session.command('agent.submit', { prompt: text, idempotencyKey }));
  }
  async get(taskId: string): Promise<TaskSummary> {
    return check(taskSummarySchema, await this.session.command('agent.get', { taskId }));
  }
  async list(): Promise<TaskSummary[]> {
    return check(taskListSchema, await this.session.command('agent.list', {})).tasks;
  }
  /** Fetches every event after afterSeq, following pages. */
  async events(taskId: string, afterSeq = 0): Promise<TaskEvent[]> {
    const all: TaskEvent[] = [];
    let cursor = afterSeq;
    for (let guard = 0; guard < 100; guard++) {
      const page = check(taskEventsPageSchema, await this.session.command('agent.events', { taskId, afterSeq: cursor }));
      all.push(...page.events);
      if (!page.hasMore || !page.events.length) return all;
      cursor = page.events[page.events.length - 1]!.seq;
    }
    return all;
  }
  async cancel(taskId: string): Promise<TaskSummary> {
    return check(taskSummarySchema, await this.session.command('agent.cancel', { taskId }));
  }
  async approve(taskId: string, approve: boolean): Promise<'approved' | 'denied'> {
    return check(approvalResultSchema, await this.session.command('agent.approve', { taskId, approve })).status;
  }
  /** Newest first: what this phone asked for and decided. */
  async audit(): Promise<AuditEntry[]> {
    return check(auditPageSchema, await this.session.command('agent.audit', {})).entries;
  }
}
