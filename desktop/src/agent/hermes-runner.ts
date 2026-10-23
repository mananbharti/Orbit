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
    throw new Error(`Hermes run ${status.status ?? 'unknown'}`);
  }

  private async consume(runId: string, context: AgentRunContext): Promise<void> {
    const response = await this.request('GET', `/v1/runs/${runId}/events`, context.signal, undefined, { Accept: 'text/event-stream' });
    if (!response.body) return;
    const decoder = new TextDecoder();
    let buffer = ''; let name = ''; let data = '';
    const dispatch = async (): Promise<void> => {
      if (!data) { name = ''; return; }
      const event = parseEvent(name, data); name = ''; data = '';
      if (event) await this.handle(runId, event, context);
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

  private async handle(runId: string, event: { type: string; data: Record<string, unknown> }, context: AgentRunContext): Promise<void> {
    const text = (value: unknown): string => typeof value === 'string' ? clean(value) : '';
    switch (event.type) {
      case 'tool.started': context.step(`Using ${text(event.data.tool) || 'tool'}${event.data.preview ? `: ${text(event.data.preview)}` : ''}`); break;
      case 'tool.completed': context.step(`${event.data.error ? 'Failed' : 'Finished'} ${text(event.data.tool) || 'tool'}`); break;
      case 'message.interim': if (text(event.data.text)) context.output(text(event.data.text)); break;
      case 'subagent.start': context.step('Delegating to a subagent'); break;
      case 'subagent.complete': context.step('Subagent finished'); break;
      case 'approval.request': {
        const approved = await context.requestApproval(text(event.data.preview ?? event.data.description ?? event.data.tool) || 'Approval needed');
        const identity = await this.approvalIdentity(runId, event, context);
        if (!identity) { context.step('Hermes gave no approval identity; the decision could not be delivered'); break; }
        const body = (this.options.approvalBody ?? defaultApprovalBody)(approved, identity);
        try { await this.request('POST', `/v1/runs/${runId}/approval`, undefined, body); }
        catch (error) {
          // 409 = the control settled or moved to a new generation while the user decided; nothing to deliver.
          if (error instanceof HermesHttpError && error.status === 409) break;
          throw error;
        }
        break;
      }
      default: break; // deltas and lifecycle frames carry no user-facing step
    }
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
