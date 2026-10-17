/** Sees and controls the computer's browser tabs through the companion extension; depends on OrbitSession and Zod. */
import { z } from 'zod';
import { InvalidDesktopReply } from './agent.js';
import type { OrbitSession } from './session.js';

export const browserTabSchema = z.strictObject({ id: z.number().int(), title: z.string(), url: z.string(), active: z.boolean(), windowId: z.number().int() });
export type BrowserTab = z.infer<typeof browserTabSchema>;

const statusSchema = z.strictObject({ connected: z.boolean() });
const listSchema = z.strictObject({ connected: z.boolean(), tabs: z.array(browserTabSchema).max(500) });
const okSchema = z.strictObject({}).loose();

export class TabsApi {
  constructor(private readonly session: OrbitSession) {}

  /** Whether the browser extension is connected to the computer right now. */
  async status(): Promise<{ connected: boolean }> {
    const parsed = statusSchema.safeParse(await this.session.command('tabs.status', {}));
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }

  async list(): Promise<{ tabs: BrowserTab[] }> {
    const parsed = listSchema.safeParse(await this.session.command('tabs.list', {}));
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }

  async open(url: string): Promise<void> {
    const parsed = okSchema.safeParse(await this.session.command('tabs.open', { url }));
    if (!parsed.success) throw new InvalidDesktopReply();
  }

  async close(tabId: number): Promise<void> {
    const parsed = okSchema.safeParse(await this.session.command('tabs.close', { tabId }));
    if (!parsed.success) throw new InvalidDesktopReply();
  }

  async activate(tabId: number): Promise<void> {
    const parsed = okSchema.safeParse(await this.session.command('tabs.activate', { tabId }));
    if (!parsed.success) throw new InvalidDesktopReply();
  }
}
