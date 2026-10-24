/** Routes agent task commands; depends on the ledger, a runner and authenticated contexts; owns no model, tool or OS access. */
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import { ProtocolError } from '../protocol/errors.js';
import type { JsonValue } from '../protocol/messages.js';
import { TERMINAL_TASK_STATES, submitTaskSchema, retryTaskSchema, taskEventsQuerySchema, taskRefSchema, MAX_TASK_EVENTS_PAGE } from '../protocol/agent-task.js';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AgentRunner } from './agent-runner.js';
import type { AuditTrail } from './audit-trail.js';
import { AUDIT_PAGE } from './audit-trail.js';
import type { TaskLedger, TaskRecord } from './task-ledger.js';
import type { TaskState } from '../protocol/agent-task.js';

export const MAX_CONCURRENT_TASKS = 2;
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const emptySchema = z.strictObject({});
const approvalSchema = z.strictObject({ taskId: z.string().uuid(), approve: z.boolean(), controlId: z.string().uuid() });

export class AgentTasks {
  private readonly unregister: (() => void)[];
  private readonly aborts = new Map<string, AbortController>();
  private readonly approvals = new Map<string, { controlId: string; settle: (approved: boolean) => void }>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly stopping = new AbortController();
  private paused: boolean;

  constructor(registry: CommandRegistry, private readonly ledger: TaskLedger, private readonly runner: AgentRunner,
    private readonly audit?: AuditTrail, private readonly pauseFile?: string,
    /** Fast-layer triage: labels a new task using the local decision model; best-effort, never blocks or fails a submission. */
    private readonly triage?: (prompt: string) => Promise<string | undefined>,
    /** Answer-only tasks: the user's picked local model gives a text answer and never takes actions. Only used when
     *  the person explicitly chose answer-only for THIS task on their phone - intent never depends on a classifier.
     *  Undefined when no model is picked; failures fail the task honestly, they never start the agent. */
    private readonly answer?: (prompt: string, signal: AbortSignal) => Promise<string | undefined>) {
    this.paused = !!pauseFile && existsSync(pauseFile);
    const owner = (context: CommandContext): string => {
      if (this.stopping.signal.aborted || !context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
      return context.session.deviceId;
    };
    this.unregister = [
      registry.register('agent.submit', { validate: p => submitTaskSchema.safeParse(p).success,
        execute: async (payload, context) => {
          const device = owner(context); const { prompt, idempotencyKey, answerOnly } = submitTaskSchema.parse(payload);
          if (this.paused) throw new ProtocolError('AGENT_PAUSED');
          const { task, created } = this.ledger.create(device, prompt, idempotencyKey, answerOnly);
          if (created) {
            this.audit?.record({ taskId: task.taskId, deviceId: device, kind: 'submitted', ...(answerOnly ? { outcome: 'answer-only' } : {}) });
            this.start(task, context);
            if (!task.answerOnly) this.triageNow(task);
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
          const { task, created } = this.ledger.create(device, original.prompt, idempotencyKey, original.answerOnly);
          if (created) {
            this.audit?.record({ taskId: task.taskId, deviceId: device, kind: 'submitted', outcome: 'retry' });
            this.start(task, context);
            if (!task.answerOnly) this.triageNow(task);
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
          this.approvals.get(task.taskId)?.settle(false);
          if (task.state === 'queued' || task.state === 'unknown') this.ledger.transition(task, 'cancelled', 'Cancelled by user');
          return summary(task);
        } }),
      registry.register('agent.approve', { validate: p => approvalSchema.safeParse(p).success,
        execute: async (payload, context) => {
          const { taskId, approve, controlId } = approvalSchema.parse(payload);
          const task = this.ledger.get(owner(context), taskId);
          const pending = this.approvals.get(taskId);
          // The decision must name the exact control it answers: a late tap on an earlier prompt
          // (timed out, then a new request on the same task) never settles the newer control.
          if (task.state !== 'awaiting-approval' || !pending || pending.controlId !== controlId) throw new ProtocolError('AGENT_INVALID_STATE');
          this.audit?.record({ taskId, deviceId: task.ownerDeviceId, kind: approve ? 'approved' : 'denied' });
          pending.settle(approve);
          return { status: approve ? 'approved' : 'denied' };
        } }),
      registry.register('agent.status', { validate: p => emptySchema.safeParse(p).success,
        execute: async (_payload, context) => { owner(context); return { paused: this.paused, answerOnly: Boolean(this.answer) }; } }),
      // Safe mode: stops everything that is running now and refuses new work until resumed. Survives restarts.
      registry.register('agent.pause', { validate: p => emptySchema.safeParse(p).success,
        execute: async (_payload, context) => {
          const device = owner(context);
          this.setPaused(true);
          this.audit?.record({ deviceId: device, kind: 'paused' });
          for (const [taskId, abort] of this.aborts) { abort.abort(); this.approvals.get(taskId)?.settle(false); }
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
    for (const pending of this.approvals.values()) pending.settle(false);
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
      if (task.answerOnly) {
        // The person explicitly asked for a text-only answer. No classifier decides anything here; a failure
        // fails the task honestly instead of silently starting the agent they opted out of.
        if (!this.answer) { this.finish(task, 'failed', 'Answer-only needs a local model: pick one in Settings on this computer'); return; }
        try {
          const text = await this.answer(task.prompt, signal);
          if (signal.aborted) return this.finish(task, 'cancelled', 'Cancelled');
          if (!text) throw new Error('empty answer');
          this.noteSafely(task, 'output', `Answered on this computer by the local model you picked. It took no actions.\n\n${text}`);
          this.finish(task, 'completed', 'Answered locally - no actions taken');
        } catch (error) {
          if (signal.aborted) return this.finish(task, 'cancelled', 'Cancelled');
          this.finish(task, 'failed', `The local model did not answer: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`);
        }
        return;
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
        // A runner may never stack a second control on the same task: the phone shows one approval
        // per task, so a stacked ask would be unanswerable and its resolver would clobber the first.
        if (this.approvals.has(task.taskId)) { this.audit?.record({ taskId: task.taskId, deviceId: task.ownerDeviceId, kind: 'approval-stacked-refused' }); return resolve(false); }
        const timer = setTimeout(() => { this.audit?.record({ taskId: task.taskId, deviceId: task.ownerDeviceId, kind: 'approval-timeout' }); settle(false); }, APPROVAL_TIMEOUT_MS);
        const settle = (approved: boolean): void => {
          clearTimeout(timer); this.approvals.delete(task.taskId);
          if (task.state === 'awaiting-approval') this.transitionSafely(task, 'running', approved ? 'Approved' : 'Denied');
          publish(); resolve(approved);
        };
        const controlId = randomUUID();
        this.approvals.set(task.taskId, { controlId, settle });
        this.transitionSafely(task, 'awaiting-approval', 'Waiting for approval');
        this.audit?.record({ taskId: task.taskId, deviceId: task.ownerDeviceId, kind: 'approval-requested' });
        this.noteSafely(task, 'approval-request', description, controlId);
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
  private noteSafely(task: TaskRecord, kind: 'step' | 'output' | 'approval-request', text: string, controlId?: string): void {
    try { this.ledger.note(task, kind, text, controlId); } catch { /* keep serving; memory holds the event */ }
  }
  private transitionSafely(task: TaskRecord, next: TaskState, text: string): void {
    try { this.ledger.transition(task, next, text); } catch { /* keep serving; memory holds the state */ }
  }
}

function summary(task: TaskRecord): JsonValue {
  return { taskId: task.taskId, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt, headline: task.headline };
}
