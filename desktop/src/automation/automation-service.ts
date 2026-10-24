/** Runs the computer's own scheduled actions on a local clock; depends on the registry, the store, and explicit executor capabilities. */
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import { ProtocolError } from '../protocol/errors.js';
import { automationIdSchema, saveAutomationSchema, setAutomationEnabledSchema } from '../protocol/automation.js';
import type { AutomationStore } from './automation-store.js';
import type { ActivityLog } from '../activity-log/activity-log.js';

/** What a scheduled action may do; each capability is wired explicitly in desktop-service so automation never reaches around the security model. */
export interface AutomationExecutor {
  launchScene(sceneId: string): Promise<void>;
  launchApp(appId: string): Promise<void>;
  power(action: 'sleep' | 'lock'): Promise<void>;
}

const TICK_MS = 15_000;

// The 'automation' command family is deliberately absent from FAMILY_SCOPE: schedules can launch apps and power the machine, so only full-access devices may manage them.
export class AutomationService {
  private readonly unregister: (() => void)[];
  private timer?: NodeJS.Timeout;
  private running = false;

  /** Desktop-owner confirmation, required before a paired device may create a scheduled power action (execution is unattended, so consent happens at creation). */
  private readonly confirmPower?: (action: 'sleep' | 'lock', context: CommandContext) => Promise<boolean>;

  constructor(registry: CommandRegistry, private readonly store: AutomationStore, private readonly executor: AutomationExecutor,
    private readonly log: ActivityLog, private readonly now: () => Date = () => new Date(),
    confirmPower?: (action: 'sleep' | 'lock', context: CommandContext) => Promise<boolean>) {
    this.confirmPower = confirmPower;
    this.unregister = [
      registry.register('automation.list', { validate: p => p === null || (typeof p === 'object' && Object.keys(p).length === 0),
        execute: async (_p, context) => { this.authorize(context); return { automations: this.store.list() }; } }),
      registry.register('automation.save', { validate: p => saveAutomationSchema.safeParse(p).success,
        execute: async (p, context) => {
          this.authorize(context);
          const parsed = saveAutomationSchema.parse(p);
          // A scheduled power action fires unattended: it must not bypass the desktop-owner gate that direct system.power has. Creation needs explicit owner confirmation.
          if (parsed.action.type === 'power' && (!this.confirmPower || !await this.confirmPower(parsed.action.action, context)))
            throw new ProtocolError('BIOMETRIC_REQUIRED');
          try { return { automations: this.store.save(parsed) }; }
          catch (error) { throw toProtocol(error); }
        } }),
      registry.register('automation.enable', { validate: p => setAutomationEnabledSchema.safeParse(p).success,
        execute: async (p, context) => {
          this.authorize(context);
          const { id, enabled } = setAutomationEnabledSchema.parse(p);
          try { return { automations: this.store.setEnabled(id, enabled) }; }
          catch (error) { throw toProtocol(error); }
        } }),
      registry.register('automation.delete', { validate: p => automationIdSchema.safeParse(p).success,
        execute: async (p, context) => {
          this.authorize(context);
          try { return { automations: this.store.remove(automationIdSchema.parse(p).id) }; }
          catch (error) { throw toProtocol(error); }
        } }),
    ];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const unregister of this.unregister) unregister();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 25)); // let an in-flight action finish before transport dies
  }

  /** Fires every enabled automation whose local time and weekday match right now; exported for tests. */
  async tick(): Promise<void> {
    if (this.running) return; // a slow action must never stack fires
    this.running = true;
    try {
      const now = this.now();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const minute = Math.floor(now.getTime() / 60_000);
      for (const automation of this.store.list()) {
        if (!automation.enabled || automation.time !== hhmm) continue;
        if (automation.days.length > 0 && !automation.days.includes(now.getDay())) continue;
        if (automation.lastFiredAt !== undefined && Math.floor(automation.lastFiredAt / 60_000) >= minute) continue;
        this.store.markFired(automation.id, now.getTime()); // mark first: a failing action never retries in a hot loop
        try {
          await this.run(automation.action);
          this.log.record({ severity: 'info', eventType: 'automation.fired', outcome: 'success' });
        } catch {
          this.log.record({ severity: 'warn', eventType: 'automation.fired', outcome: 'failed' });
        }
      }
    } finally { this.running = false; }
  }

  private async run(action: { type: 'scene'; sceneId: string } | { type: 'app'; appId: string } | { type: 'power'; action: 'sleep' | 'lock' }): Promise<void> {
    if (action.type === 'scene') await this.executor.launchScene(action.sceneId);
    else if (action.type === 'app') await this.executor.launchApp(action.appId);
    else await this.executor.power(action.action);
  }

  private authorize(context: CommandContext): void {
    if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
  }
}

function toProtocol(error: unknown): never {
  if (error instanceof Error && error.message === 'AUTOMATION_NOT_FOUND') throw new ProtocolError('AUTOMATION_NOT_FOUND');
  if (error instanceof Error && error.message === 'AUTOMATION_LIMIT') throw new ProtocolError('AUTOMATION_LIMIT');
  throw error;
}
