/** Registers feature handlers; depends on protocol/context types; performs no OS operations or transport work. */
import type { JsonValue } from '../protocol/messages.js';
import { COMMAND_PATTERN } from '../protocol/validation.js';
import type { CommandContext } from './command-context.js';

export interface CommandHandler {
  validate(payload: JsonValue): boolean;
  execute(payload: JsonValue, context: CommandContext): Promise<JsonValue>;
}

export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();

  register(type: string, handler: CommandHandler): () => void {
    if (!COMMAND_PATTERN.test(type) || type.length > 64 || type.startsWith('session.')
      || this.handlers.has(type)) throw new Error('Invalid or duplicate command registration');
    this.handlers.set(type, handler);
    return () => { if (this.handlers.get(type) === handler) this.handlers.delete(type); };
  }

  get(type: string): CommandHandler | undefined { return this.handlers.get(type); }
}
