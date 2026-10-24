/** Persists agent tasks and their events; depends on node:fs and the agent protocol; never runs agents or reads prompts into logs. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ProtocolError } from '../protocol/errors.js';
import { TERMINAL_TASK_STATES, taskEventSchema, taskIdSchema, taskPromptSchema, taskStateSchema, type TaskState } from '../protocol/agent-task.js';

export const MAX_LEDGER_TASKS = 500;
export const MAX_EVENTS_PER_TASK = 1_000;
const recordSchema = z.strictObject({ taskId: taskIdSchema, idempotencyKey: z.string().uuid(), ownerDeviceId: z.string().uuid(),
  prompt: taskPromptSchema, state: taskStateSchema, createdAt: z.number().int(), updatedAt: z.number().int(),
  headline: z.string().max(200), answerOnly: z.boolean().default(false), events: z.array(taskEventSchema).max(MAX_EVENTS_PER_TASK) });
const fileSchema = z.strictObject({ version: z.literal(1), tasks: z.array(recordSchema).max(MAX_LEDGER_TASKS) });
export type TaskRecord = z.infer<typeof recordSchema>;

// Allowed transitions. Terminal states never change; 'unknown' is only assigned by crash reconciliation.
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ['running', 'cancelled'],
  running: ['awaiting-approval', 'paused', 'completed', 'failed', 'cancelled', 'unknown'],
  'awaiting-approval': ['running', 'cancelled', 'failed', 'unknown'],
  paused: ['running', 'cancelled', 'unknown'],
  completed: [], failed: [], cancelled: [], unknown: ['cancelled', 'failed'],
};

export class TaskLedger {
  private readonly path: string;
  private readonly tasks = new Map<string, TaskRecord>();
  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.path = join(directory, 'agent-tasks.json');
    if (existsSync(this.path)) {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (!parsed.success) throw new ProtocolError('AGENT_LEDGER_IO'); // fail closed; never discard a corrupt ledger silently
      for (const task of parsed.data.tasks) this.tasks.set(task.taskId, task);
    }
    this.reconcile();
  }
  /** A restart cannot resume a running harness, so its outcome is honestly "unknown" rather than assumed. */
  private reconcile(): void {
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.state === 'running' || task.state === 'awaiting-approval' || task.state === 'paused' || task.state === 'queued') {
        this.transitionInternal(task, task.state === 'queued' ? 'cancelled' : 'unknown',
          task.state === 'queued' ? 'Cancelled: service restarted before start' : 'Service restarted; outcome unknown');
        changed = true;
      }
    }
    if (changed) this.save();
  }
  create(ownerDeviceId: string, prompt: string, idempotencyKey: string, answerOnly = false): { task: TaskRecord; created: boolean } {
    for (const task of this.tasks.values()) {
      if (task.ownerDeviceId === ownerDeviceId && task.idempotencyKey === idempotencyKey) return { task, created: false };
    }
    if (this.tasks.size >= MAX_LEDGER_TASKS) this.evictOldestTerminal();
    const at = this.now();
    const task: TaskRecord = { taskId: randomUUID(), idempotencyKey, ownerDeviceId, prompt, state: 'queued',
      createdAt: at, updatedAt: at, headline: prompt.slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'Task', answerOnly, events: [] };
    this.tasks.set(task.taskId, task);
    this.append(task, 'state', 'Queued');
    this.save();
    return { task, created: true };
  }
  get(ownerDeviceId: string, taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    // Same error for missing and foreign tasks so IDs cannot be probed across devices.
    if (!task || task.ownerDeviceId !== ownerDeviceId) throw new ProtocolError('AGENT_NOT_FOUND');
    return task;
  }
  list(ownerDeviceId: string): TaskRecord[] {
    return [...this.tasks.values()].filter(task => task.ownerDeviceId === ownerDeviceId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  }
  activeCount(): number {
    return [...this.tasks.values()].filter(task => task.state === 'running' || task.state === 'awaiting-approval' || task.state === 'paused').length;
  }
  transition(task: TaskRecord, next: TaskState, text: string): void {
    this.transitionInternal(task, next, text);
    this.save();
  }
  note(task: TaskRecord, kind: 'step' | 'output' | 'approval-request', text: string, controlId?: string): void {
    if (TERMINAL_TASK_STATES.has(task.state)) return;
    this.append(task, kind, text, controlId);
    this.save();
  }
  private transitionInternal(task: TaskRecord, next: TaskState, text: string): void {
    if (!TRANSITIONS[task.state].includes(next)) throw new ProtocolError('AGENT_INVALID_STATE');
    task.state = next;
    this.append(task, 'state', text);
  }
  private append(task: TaskRecord, kind: 'state' | 'step' | 'output' | 'approval-request', text: string, controlId?: string): void {
    const at = this.now();
    task.updatedAt = at;
    if (task.events.length >= MAX_EVENTS_PER_TASK) task.events.splice(0, 1); // bounded: oldest event drops, seq stays monotonic
    const seq = (task.events.at(-1)?.seq ?? 0) + 1;
    task.events.push({ seq, at, kind, text: text.slice(0, 2_000), ...(controlId ? { controlId } : {}) });
  }
  private evictOldestTerminal(): void {
    const victim = [...this.tasks.values()].filter(task => TERMINAL_TASK_STATES.has(task.state) || task.state === 'unknown')
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!victim) throw new ProtocolError('AGENT_LIMIT');
    this.tasks.delete(victim.taskId);
  }
  private save(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, tasks: [...this.tasks.values()] }), { mode: 0o600 });
      renameSync(temporary, this.path); // atomic replace: a crash leaves the previous complete ledger
    } catch { throw new ProtocolError('AGENT_LEDGER_IO'); }
  }
}
