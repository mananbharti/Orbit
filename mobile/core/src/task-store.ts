/** Keeps the phone's view of agent tasks consistent with the desktop; depends on AgentApi and OrbitSession; does not render UI or persist data. */
import type { AgentApi } from './agent.js';
import { TERMINAL_TASK_STATES, taskSummarySchema, type TaskEvent, type TaskSummary } from './protocol.js';
import { CommandError, type DesktopEvent, type OrbitSession, type SessionStatus } from './session.js';

export interface TaskStoreState {
  connection: SessionStatus;
  /** Newest first. */
  tasks: TaskSummary[];
  /** Tasks whose latest state needs the user right now. */
  needsAttention: TaskSummary[];
  /** False once the desktop answered "no such command": the agent backend is not configured there. */
  agentAvailable?: boolean;
  events: Record<string, TaskEvent[]>;
  lastError?: string;
}

export class TaskStore {
  private tasks = new Map<string, TaskSummary>();
  private events = new Map<string, TaskEvent[]>();
  private listeners = new Set<() => void>();
  private lastError?: string;
  private snapshot: TaskStoreState;
  private disposers: (() => void)[] = [];
  private refreshing = false;
  private agentAvailable?: boolean;
  /** Tasks changed by a push or update while a list request was in flight; the older list must not override them. */
  private touched = new Set<string>();

  constructor(private readonly session: OrbitSession, private readonly api: AgentApi) {
    this.snapshot = this.build();
    this.disposers.push(session.onEvent(e => this.onDesktopEvent(e)));
    this.disposers.push(session.onStatus(status => {
      if (status === 'connected') void this.refresh();
      this.emit();
    }));
    if (session.status === 'connected') void this.refresh();
  }

  getState = (): TaskStoreState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  dispose(): void { for (const d of this.disposers.splice(0)) d(); this.listeners.clear(); }

  /** Reloads the list from the desktop. Safe to call repeatedly; overlapping calls are merged. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.touched.clear();
    try {
      const list = await this.api.list();
      const next = new Map(list.map(t => [t.taskId, t]));
      for (const id of this.touched) {
        const local = this.tasks.get(id); const listed = next.get(id);
        if (local && (!listed || local.updatedAt >= listed.updatedAt)) next.set(id, local);
      }
      this.tasks = next;
      this.lastError = undefined;
      this.agentAvailable = true;
      for (const t of list) if (this.events.has(t.taskId) || !TERMINAL_TASK_STATES.has(t.state)) void this.loadEvents(t.taskId);
    } catch (error) {
      // UNKNOWN_COMMAND means the desktop runs without an agent backend: a setup state, not an error.
      if (error instanceof CommandError && error.code === 'UNKNOWN_COMMAND') this.agentAvailable = false;
      else this.lastError = describe(error);
    }
    finally { this.refreshing = false; this.emit(); }
  }

  /** Fetches only events newer than the ones already held. */
  async loadEvents(taskId: string): Promise<void> {
    const have = this.events.get(taskId) ?? [];
    try {
      const fresh = await this.api.events(taskId, have.at(-1)?.seq ?? 0);
      // Overlapping loads (screen mount + refresh) can fetch the same page twice: never show an event twice.
      const known = new Set(have.map(e => e.seq));
      const deduped = fresh.filter(e => !known.has(e.seq));
      if (deduped.length) this.events.set(taskId, [...have, ...deduped]); else if (!this.events.has(taskId)) this.events.set(taskId, have);
      this.lastError = undefined;
    } catch (error) { this.lastError = describe(error); }
    this.emit();
  }

  async submit(prompt: string, options?: { answerOnly?: boolean }): Promise<TaskSummary> {
    const task = await this.api.submit(prompt, undefined, options);
    this.tasks.set(task.taskId, task);
    this.emit();
    return task;
  }
  /** New run of a failed, cancelled or interrupted task. Returns the new task; the old one is unchanged. */
  async retry(taskId: string): Promise<TaskSummary> {
    const task = await this.api.retry(taskId);
    this.tasks.set(task.taskId, task);
    this.emit();
    return task;
  }
  async cancel(taskId: string): Promise<void> { this.put(await this.api.cancel(taskId)); }
  async approve(taskId: string, approve: boolean): Promise<void> {
    await this.api.approve(taskId, approve);
    this.put(await this.api.get(taskId));
    await this.loadEvents(taskId);
  }

  private put(task: TaskSummary): void {
    const current = this.tasks.get(task.taskId);
    if (current && current.updatedAt > task.updatedAt) return;
    this.tasks.set(task.taskId, task);
    this.touched.add(task.taskId);
    this.emit();
  }

  private onDesktopEvent(event: DesktopEvent): void {
    if (event.eventType !== 'agent.task') return;
    const parsed = taskSummarySchema.safeParse(event.data);
    if (!parsed.success) return;
    this.put(parsed.data);
    void this.loadEvents(parsed.data.taskId);
  }

  private build(): TaskStoreState {
    const tasks = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    return { connection: this.session.status, tasks, needsAttention: tasks.filter(t => t.state === 'awaiting-approval' || t.state === 'unknown'),
      events: Object.fromEntries(this.events), ...(this.agentAvailable !== undefined ? { agentAvailable: this.agentAvailable } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}) };
  }
  private emit(): void {
    this.snapshot = this.build();
    for (const l of [...this.listeners]) l();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}
