/** Defines the harness boundary; depends on nothing; implementations (e.g. Hermes over MCP) own model and tool execution. */
export interface AgentRunContext {
  readonly taskId: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  step(text: string): void;
  output(text: string): void;
  /** Resolves true when the user approves; false on denial, cancellation or timeout. Never auto-approves. */
  requestApproval(description: string): Promise<boolean>;
}

export interface AgentRunner {
  /** Resolves with a short final summary, or rejects on failure. Must stop promptly when signal aborts. */
  run(context: AgentRunContext): Promise<string>;
}

/** A runner error whose message is safe to show on the phone: built from status codes and
 *  sanitized gateway text, never from local paths, stacks, credentials or tool payloads.
 *  agent-tasks surfaces only this class's message; any other error stays a bare 'Failed'. */
export class AgentRunError extends Error { readonly phoneSafe = true as const; }
