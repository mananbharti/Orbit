/** Runs agent tasks on a local Hermes gateway through its documented Runs API; depends on fetch and the runner boundary; never executes tools itself. */
import type { AgentRunContext, AgentRunner } from './agent-runner.js';

export interface HermesRunnerOptions {
  /** Base URL of the Hermes API server. Must be loopback unless allowRemote is set. */
  baseUrl?: string;
  apiKey: string;
  allowRemote?: boolean;
  fetchImpl?: typeof fetch;
  /** Body for POST /v1/runs/{id}/approval. The documented contract carries the control identity:
   *  { request_id, execution_generation, choice: 'once' | 'deny' } - identityless answers get HTTP 409. */
  approvalBody?: (approved: boolean, identity: ApprovalIdentity) => Record<string, unknown>;
}

const MAX_LINE_BYTES = 256 * 1_024;
const MAX_TEXT = 1_900;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export interface ApprovalIdentity { requestId: string; generation: number }

/** Thrown for any non-2xx Hermes response; carries the status so callers can tolerate specific ones. */
export class HermesHttpError extends Error { constructor(readonly status: number) { super(`Hermes HTTP ${status}`); } }

export class HermesRunner implements AgentRunner {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: HermesRunnerOptions) {
    this.base = new URL(options.baseUrl ?? 'http://127.0.0.1:8642');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(this.base.hostname);
    if (!options.apiKey || /[\r\n]/.test(options.apiKey)) throw new Error('Hermes API key is required');
    if (!loopback && !options.allowRemote) throw new Error('Refusing non-loopback Hermes endpoint');
    if (this.base.protocol !== 'http:' && this.base.protocol !== 'https:') throw new Error('Unsupported Hermes URL');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** One reachability probe against the documented capability list: 'ok' when the gateway answers,
   *  'unauthorized' when the key is rejected, 'unreachable' when nothing listens, 'error' otherwise. */
  async check(): Promise<'ok' | 'unauthorized' | 'unreachable' | 'error'> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL('/v1/capabilities', this.base), { redirect: 'error',
        headers: { Authorization: `Bearer ${this.options.apiKey}` }, signal: AbortSignal.timeout(4_000) });
    } catch { return 'unreachable'; }
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    return response.ok ? 'ok' : 'error';
  }

  async run(context: AgentRunContext): Promise<string> {
    const created = await this.request('POST', '/v1/runs', context.signal,
      { input: context.prompt, session_id: context.taskId }, { 'Idempotency-Key': context.taskId });
    const runId = (await created.json() as { run_id?: unknown }).run_id;
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new Error('Hermes returned no run id');
    const onAbort = (): void => { void this.request('POST', `/v1/runs/${runId}/stop`, undefined).catch(() => undefined); };
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.consume(runId, context);
    } finally { context.signal.removeEventListener('abort', onAbort); }
    // The status endpoint is the authority; the event stream only provides progress.
    const status = await (await this.request('GET', `/v1/runs/${runId}`, context.signal)).json() as { status?: string; output?: unknown; error?: unknown };
    if (status.status === 'completed') return typeof status.output === 'string' && status.output ? status.output : 'Done';
    if (status.status && !TERMINAL.has(status.status)) throw new Error('Hermes run did not finish');
    // Surface the gateway's own reason (for example a missing model provider) so the phone shows why.
    const reason = typeof status.error === 'string' && status.error ? `: ${clean(status.error)}` : '';
    throw new Error(`Hermes run ${status.status ?? 'unknown'}${reason}`);
  }

  private async consume(runId: string, context: AgentRunContext): Promise<void> {
    const state = { active: true };
    try { await this.consumeStream(runId, context, state); } finally { state.active = false; }
  }

  private async consumeStream(runId: string, context: AgentRunContext, state: { active: boolean }): Promise<void> {
    const response = await this.request('GET', `/v1/runs/${runId}/events`, context.signal, undefined, { Accept: 'text/event-stream' });
    if (!response.body) return;
    const decoder = new TextDecoder();
    let buffer = ''; let name = ''; let data = '';
    const dispatch = async (): Promise<void> => {
      if (!data) { name = ''; return; }
      const event = parseEvent(name, data); name = ''; data = '';
      if (event) await this.handle(runId, event, context, state);
    };
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > MAX_LINE_BYTES * 4) throw new Error('Hermes event stream too large');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (line.length > MAX_LINE_BYTES) throw new Error('Hermes event line too large');
        if (line === '') await dispatch();
        else if (line.startsWith(':')) continue; // keepalive comment
        else if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
      }
    }
    await dispatch();
  }

  private async handle(runId: string, event: { type: string; data: Record<string, unknown> }, context: AgentRunContext, state: { active: boolean }): Promise<void> {
    const text = (value: unknown): string => typeof value === 'string' ? clean(value) : '';
    switch (event.type) {
      case 'tool.started': context.step(`Using ${text(event.data.tool) || 'tool'}${event.data.preview ? `: ${text(event.data.preview)}` : ''}`); break;
      case 'tool.completed': context.step(`${event.data.error ? 'Failed' : 'Finished'} ${text(event.data.tool) || 'tool'}`); break;
      case 'message.interim': if (text(event.data.text)) context.output(text(event.data.text)); break;
      case 'subagent.start': context.step('Delegating to a subagent'); break;
      case 'subagent.complete': context.step('Subagent finished'); break;
      case 'approval.request': {
        const detail = text(event.data.description) || text(event.data.command) || text(event.data.preview) || text(event.data.tool) || 'Approval needed';
        const identity = await this.approvalIdentity(runId, event, context);
        // Never downgrade: an event that carries identity fields but no usable identity is
        // malformed, not identity-less - answering it with a plain choice could settle a control
        // the user never saw.
        const mentionsIdentity = 'prompt_id' in event.data || 'request_id' in event.data || 'execution_generation' in event.data;
        if (mentionsIdentity && !identity) { context.step('Hermes sent a malformed approval identity; the decision was not delivered'); break; }
        const approved = await context.requestApproval(detail);
        // Deliver only while the same stream that showed the request is still live; a dead stream
        // means Orbit can no longer observe what control is pending.
        if (!state.active) { context.step('The run stream ended before the answer; it was not delivered'); break; }
        let body: Record<string, unknown>;
        if (identity) {
          // Newer gateways implementing the documented request_id/execution_generation contract:
          // the identity binds the answer to the exact control, so a late answer cannot settle a newer one.
          body = (this.options.approvalBody ?? defaultApprovalBody)(approved, identity);
        } else {
          // Gateways up to at least v0.19.0 carry no control identity: their endpoint takes
          // { choice } and resolves whatever is pending for the run. Because that could settle a
          // different control than the one displayed, deliver only while the run still reports
          // waiting_for_approval and the gateway advertises the approval endpoint; otherwise refuse.
          // Residual race: a control settling and a new one appearing between this check and the
          // POST cannot be excluded against v0.19.0; the window is the round-trip itself.
          const current = await this.runStatus(runId);
          if (current !== 'waiting_for_approval') { context.step(`The approval was no longer pending when the answer arrived (${current ?? 'status unknown'}); it was not delivered`); break; }
          const features = (await this.capabilities())?.features as Record<string, unknown> | undefined;
          if (features?.run_approval_response !== true) { context.step('This gateway does not advertise approval answers; the decision was not delivered'); break; }
          body = { choice: approved ? 'once' : 'deny' };
        }
        try { await this.request('POST', `/v1/runs/${runId}/approval`, undefined, body); }
        catch (error) {
          // 409 = the control settled or moved on while the user decided. It never means accepted.
          if (error instanceof HermesHttpError && error.status === 409) { context.step('Hermes had already settled or superseded the approval; the answer was not delivered'); break; }
          throw error;
        }
        break;
      }
      default: break; // deltas and lifecycle frames carry no user-facing step
    }
  }

  /** Current run status, undefined when it cannot be read (callers fail closed). */
  private async runStatus(runId: string): Promise<string | undefined> {
    try {
      const status = await (await this.request('GET', `/v1/runs/${runId}`, undefined)).json() as { status?: unknown };
      return typeof status.status === 'string' ? status.status : undefined;
    } catch { return undefined; }
  }

  private capsPromise?: Promise<Record<string, unknown> | undefined>;
  /** The gateway's advertised capability list, fetched once; undefined when unreadable. */
  private capabilities(): Promise<Record<string, unknown> | undefined> {
    return (this.capsPromise ??= this.request('GET', '/v1/capabilities', undefined)
      .then(response => response.json() as Promise<Record<string, unknown>>).catch(() => undefined));
  }

  /** The control identity for an approval: from the event itself, else the run's pending_controls. */
  private async approvalIdentity(runId: string, event: { data: Record<string, unknown> }, context: AgentRunContext): Promise<ApprovalIdentity | undefined> {
    const fromEvent = readIdentity(event.data);
    if (fromEvent) return fromEvent;
    try {
      const status = await (await this.request('GET', `/v1/runs/${runId}`, context.signal)).json() as { pending_controls?: unknown };
      if (status.pending_controls && typeof status.pending_controls === 'object' && !Array.isArray(status.pending_controls)) {
        return readIdentity(status.pending_controls as Record<string, unknown>);
      }
    } catch { /* a gateway without pending_controls simply cannot be answered */ }
    return undefined;
  }

  private request(method: string, path: string, signal: AbortSignal | undefined, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.fetchImpl(new URL(path, this.base), { method, signal, redirect: 'error',
      headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) }).then(response => {
      if (!response.ok) throw new HermesHttpError(response.status);
      return response;
    });
  }
}

function readIdentity(record: Record<string, unknown>): ApprovalIdentity | undefined {
  const requestId = typeof record.prompt_id === 'string' ? record.prompt_id
    : typeof record.request_id === 'string' ? record.request_id : undefined;
  const generation = typeof record.execution_generation === 'number' && Number.isInteger(record.execution_generation)
    ? record.execution_generation : undefined;
  return requestId && generation !== undefined ? { requestId, generation } : undefined;
}

function defaultApprovalBody(approved: boolean, identity: ApprovalIdentity): Record<string, unknown> {
  return { request_id: identity.requestId, execution_generation: identity.generation, choice: approved ? 'once' : 'deny' };
}
function clean(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT); }
function parseEvent(name: string, data: string): { type: string; data: Record<string, unknown> } | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const type = name || (typeof record.event === 'string' ? record.event : typeof record.type === 'string' ? record.type : '');
  return type ? { type, data: record } : undefined;
}
