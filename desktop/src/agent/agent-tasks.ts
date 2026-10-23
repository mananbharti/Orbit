/** Routes agent task commands; depends on the ledger, a runner and authenticated contexts; owns no model, tool or OS access. */
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import { ProtocolError } from '../protocol/errors.js';
import type { JsonValue } from '../protocol/messages.js';
import { TERMINAL_TASK_STATES, submitTaskSchema, retryTaskSchema, taskEventsQuerySchema, taskRefSchema, MAX_TASK_EVENTS_PAGE } from '../protocol/agent-task.js';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { AgentRunner } from './agent-runner.js';
import type { AuditTrail } from './audit-trail.js';
import { AUDIT_PAGE } from './audit-trail.js';
import type { TaskLedger, TaskRecord } from './task-ledger.js';
import type { TaskState } from '../protocol/agent-task.js';

export const MAX_CONCURRENT_TASKS = 2;
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const emptySchema = z.strictObject({});
const approvalSchema = z.strictObject({ taskId: z.string().uuid(), approve: z.boolean() });

export class AgentTasks {
  private readonly unregister: (() => void)[];
  private readonly aborts = new Map<string, AbortController>();
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly stopping = new AbortController();
  private paused: boolean;

  constructor(registry: CommandRegistry, private readonly ledger: TaskLedger, private readonly runner: AgentRunner,
    private readonly audit?: AuditTrail, private readonly pauseFile?: string,
    /** Fast-layer triage: labels a new task using the local decision model; best-effort, never blocks or fails a submission. */
    private readonly triage?: (prompt: string) => Promise<string | undefined>,
    /** Fast answers: the user's picked local model answers answer-only kinds (research, other) with text and never
     *  takes actions; returns undefined for every other kind. Any failure falls back to the agent, never to a guess. */
    private readonly answer?: (prompt: string, kind: string, signal: AbortSignal) => Promise<string | undefined>) {
    this.paused = !!pauseFile && existsSync(pauseFile);
    const owner = (context: CommandContext): string => {
      if (this.stopping.signal.aborted || !context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
      return context.session.deviceId;
    };
    this.unregister = [
      registry.register('agent.submit', { validate: p => submitTaskSchema.safeParse(p).success,
        execute: async (payload, context) => {
          const device = owner(context); const { prompt, idempotencyKey } = submitTaskSchema.parse(payload);
          if (this.paused) throw new ProtocolError('AGENT_PAUSED');
          const { task, created } = this.ledger.create(device, prompt, idempotencyKey);
          if (created) {
            this.audit?.record({ taskId: task.taskId, deviceId: device, kind: 'submitted' });
            this.start(task, context);
            if (!this.answer) this.triageNow(task);
          }
          return summary(task);
        } }),
      // Starts a NEW task with the same request after a failed, cancelled or interrupted one. The old task is left as it was: an
      // interrupted task may already have done part of its work, so the phone must make clear this is a fresh run, not a resume.
      registry.register('agent.retry', { validate: p => retryTaskSchema.safeParse(p).success,
        execute: async (payload, context) => {
          const device = owner(context); const { taskId, idempotencyKey } = retryTaskSchema.parse(payload);
          const original = this.ledger.get(device, taskId);
          if (!['failed', 'cancelled', 'unknown'].includes(original.state)) throw new ProtocolError('AGENT_INVALID_STATE');
          if (this.paused) throw new ProtocolError('AGENT_PAUSED');
          const { task, created } = this.ledger.create(device, original.prompt, idempotencyKey);
          if (created) {
            this.audit?.record({ taskId: task.taskId, deviceId: device, kind: 'submitted', outcome: 'retry' });
            this.start(task, context);
            if (!this.answer) this.triageNow(task);
          }
          return summary(task);
        } }),
      registry.register('agent.get', { validate: p => taskRefSchema.safeParse(p).success,
        execute: async (payload, context) => summary(this.ledger.get(owner(context), taskRefSchema.parse(payload).taskId)) }),
      registry.register('agent.list', { validate: p => emptySchema.safeParse(p).success,
        execute: async (_payload, context) => ({ tasks: this.ledger.list(owner(context)).map(summary) }) }),
      registry.register('agent.events', { validate: p => taskEventsQuerySchema.safeParse(p).success,
        execute: async (payload, context) => {
          const { taskId, afterSeq } = taskEventsQuerySchema.parse(payload);
          const task = this.ledger.get(owner(context), taskId);
          const all = task.events.filter(event => event.seq > afterSeq);
          return { events: all.slice(0, MAX_TASK_EVENTS_PAGE), hasMore: all.length > MAX_TASK_EVENTS_PAGE };
        } }),
      registry.register('agent.cancel', { validate: p => taskRefSchema.safeParse(p).success,
        execute: async (payload, context) => {
          const task = this.ledger.get(owner(context), taskRefSchema.parse(payload).taskId);
          if (TERMINAL_TASK_STATES.has(task.state)) throw new ProtocolError('AGENT_INVALID_STATE');
          this.audit?.record({ taskId: task.taskId, deviceId: task.ownerDeviceId, kind: 'cancelled-by-user' });
          this.aborts.get(task.taskId)?.abort();
          this.approvals.get(task.taskId)?.(false);
          if (task.state === 'queued' || task.state === 'unknown') this.ledger.transition(task, 'cancelled', 'Cancelled by user');
          return summary(task);
        } }),
      registry.register('agent.approve', { validate: p => approvalSchema.safeParse(p).success,
        execute: async (payload, context) => {
          const { taskId, approve } = approvalSchema.parse(payload);
          const task = this.ledger.get(owner(context), taskId);
          const resolve = this.approvals.get(taskId);
          if (task.state !== 'awaiting-approval' || !resolve) throw new ProtocolError('AGENT_INVALID_STATE');
          this.audit?.record({ taskId, deviceId: task.ownerDeviceId, kind: approve ? 'approved' : 'denied' });
          resolve(approve);
          return { status: approve ? 'approved' : 'denied' };
        } }),
      registry.register('agent.status', { validate: p => emptySchema.safeParse(p).success,
        execute: async (_payload, context) => { owner(context); return { paused: this.paused }; } }),
      // Safe mode: stops everything that is running now and refuses new work until resumed. Survives restarts.
      registry.register('agent.pause', { validate: p => emptySchema.safeParse(p).success,
        execute: async (_payload, context) => {
          const device = owner(context);
          this.setPaused(true);
          this.audit?.record({ deviceId: device, kind: 'paused' });
          for (const [taskId, abort] of this.aborts) { abort.abort(); this.approvals.get(taskId)?.(false); }
          return { paused: true };
        } }),
      registry.register('agent.resume', { validate: p => emptySchema.safeParse(p).success,
        execute: async (_payload, context) => {
          const device = owner(context);
          this.setPaused(false);
          this.audit?.record({ deviceId: device, kind: 'resumed' });
          return { paused: false };
        } }),
      registry.register('agent.audit', { validate: p => emptySchema.safeParse(p).success,
        execute: async (_payload, context) => ({ entries: this.audit?.forDevice(owner(context), AUDIT_PAGE) ?? [] }) }),
    ];
  }

  private setPaused(value: boolean): void {
    if (this.pauseFile) {
      try { if (value) writeFileSync(this.pauseFile, '1', { mode: 0o600 }); else rmSync(this.pauseFile, { force: true }); }
      catch { throw new ProtocolError('AGENT_LEDGER_IO'); } // never claim safe mode if it cannot be made durable
    }
    this.paused = value;
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    for (const abort of this.aborts.values()) abort.abort();
    for (const resolve of this.approvals.values()) resolve(false);
    for (const unregister of this.unregister) unregister();
    await Promise.allSettled(this.jobs);
  }

  private triageNow(task: TaskRecord): void {
    if (!this.triage) return;
    void this.triage(task.prompt)
      .then(label => { if (label) this.ledger.note(task, 'step', `Triaged as "${label}" by the local decision model`); })
      .catch(() => undefined); // triage is a hint; the task runs regardless
  }

  private start(task: TaskRecord, context: CommandContext): void {
    if (this.ledger.activeCount() >= MAX_CONCURRENT_TASKS) {
      this.ledger.transition(task, 'cancelled', 'Rejected: too many active tasks');
      throw new ProtocolError('AGENT_LIMIT');
    }
    const abort = new AbortController();
    this.aborts.set(task.taskId, abort);
    this.ledger.transition(task, 'running', 'Started');
    const signal = AbortSignal.any([abort.signal, this.stopping.signal]);
    const publish = (): void => { try { context.connection?.publish('agent.task', summary(task)); } catch { /* socket gone; ledger remains the record */ } };
    const job = (async (): Promise<void> => {
      if (this.answer) {
        let kind: string | undefined;
        try { kind = await this.triage?.(task.prompt); } catch { kind = undefined; }
        if (kind) { this.noteSafely(task, 'step', `Triaged as "${kind}" by the local decision model`); publish(); }
        if (kind && !signal.aborted) {
          let text: string | undefined;
          try { text = await this.answer(task.prompt, kind, signal); } catch { text = undefined; }
          if (text && !signal.aborted) {
            this.noteSafely(task, 'output', `Answered on this computer by the local model you picked. It took no actions.\n\n${text}`);
            this.finish(task, 'completed', 'Answered locally - no actions taken');
            return;
          }
        }
      }
      await this.runAgent(task, signal, publish);
    })().finally(() => { this.aborts.delete(task.taskId); this.jobs.delete(job); publish(); });
    this.jobs.add(job);
  }

  private async runAgent(task: TaskRecord, signal: AbortSignal, publish: () => void): Promise<void> {
    await this.runner.run({ taskId: task.taskId, prompt: task.prompt, signal,
      step: text => { this.noteSafely(task, 'step', text); publish(); },
      output: text => { this.noteSafely(task, 'output', text); publish(); },
      requestApproval: description => new Promise<boolean>(resolve => {
        if (signal.aborted || TERMINAL_TASK_STATES.has(task.state)) return resolve(false);
        const timer = setTimeout(() => { this.audit?.record({ taskId: task.taskId, deviceId: task.ownerDeviceId, kind: 'approval-timeout' }); settle(false); }, APPROVAL_TIMEOUT_MS);
        const settle = (approved: boolean): void => {
          clearTimeout(timer); this.approvals.delete(task.taskId);
          if (task.state === 'awaiting-approval') this.transitionSafely(task, 'running', approved ? 'Approved' : 'Denied');
          publish(); resolve(approved);
        };
        this.approvals.set(task.taskId, settle);
        this.transitionSafely(task, 'awaiting-approval', 'Waiting for approval');
        this.audit?.record({ taskId: task.taskId, deviceId: task.ownerDeviceId, kind: 'approval-requested' });
        this.noteSafely(task, 'approval-request', description);
        publish();
      }) })
      .then(result => {
        if (signal.aborted) return this.finish(task, 'cancelled', 'Cancelled');
        this.finish(task, 'completed', result.slice(0, 500));
      }, () => this.finish(task, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? 'Cancelled' : 'Failed'));
  }

  private finish(task: TaskRecord, state: 'completed' | 'failed' | 'cancelled', text: string): void {
    if (TERMINAL_TASK_STATES.has(task.state)) return;
    this.transitionSafely(task, state, text);
    this.audit?.record({ taskId: task.taskId, deviceId: task.ownerDeviceId, kind: 'finished', outcome: state });
  }

  // Disk trouble on the async path must never reach the runner or reject the job: transitionInternal has already
  // moved the in-memory record before save() throws, so the service keeps a true picture and the next save persists it.
  private noteSafely(task: TaskRecord, kind: 'step' | 'output' | 'approval-request', text: string): void {
    try { this.ledger.note(task, kind, text); } catch { /* keep serving; memory holds the event */ }
  }
  private transitionSafely(task: TaskRecord, next: TaskState, text: string): void {
    try { this.ledger.transition(task, next, text); } catch { /* keep serving; memory holds the state */ }
  }
}

function summary(task: TaskRecord): JsonValue {
  return { taskId: task.taskId, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt, headline: task.headline };
}
