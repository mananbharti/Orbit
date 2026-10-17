/** Reads and edits the computer's scheduled actions; depends on OrbitSession and Zod; only full-access devices may call these. */
import { InvalidDesktopReply } from './agent.js';
import { automationListResultSchema, type Automation, type AutomationAction } from './protocol.js';
import type { OrbitSession } from './session.js';

const AUTOMATION_TIMEOUT_MS = 10_000;

export class AutomationApi {
  private automations: Automation[] = [];
  constructor(private readonly session: OrbitSession) {
    session.onStatus(() => { this.automations = []; });
  }

  getAutomations(): Automation[] { return [...this.automations]; }

  async refresh(): Promise<Automation[]> {
    return this.apply(await this.session.command('automation.list', {}, { timeoutMs: AUTOMATION_TIMEOUT_MS }));
  }

  /** Creates without an id, replaces with one. Returns the fresh list. */
  async save(entry: { id?: string; time: string; days: number[]; action: AutomationAction }): Promise<Automation[]> {
    return this.apply(await this.session.command('automation.save', entry, { timeoutMs: AUTOMATION_TIMEOUT_MS }));
  }

  async setEnabled(id: string, enabled: boolean): Promise<Automation[]> {
    return this.apply(await this.session.command('automation.enable', { id, enabled }, { timeoutMs: AUTOMATION_TIMEOUT_MS }));
  }

  async remove(id: string): Promise<Automation[]> {
    return this.apply(await this.session.command('automation.delete', { id }, { timeoutMs: AUTOMATION_TIMEOUT_MS }));
  }

  private apply(result: unknown): Automation[] {
    const parsed = automationListResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    this.automations = parsed.data.automations;
    return this.getAutomations();
  }
}
