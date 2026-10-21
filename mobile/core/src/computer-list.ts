/** Pure multi-computer list logic (migration, upsert, removal, active choice); depends on the pairing schema only, so it is fully unit-testable away from the OS secure store. */
import { z } from 'zod';
import { pairedDesktopSchema, type PairedDesktop } from './protocol.js';

export const MAX_COMPUTERS = 8;
const listSchema = z.array(pairedDesktopSchema).max(MAX_COMPUTERS);

export interface ComputerList { list: PairedDesktop[]; activeId?: string }

/** Parses the stored list blob; undefined when it is missing or corrupt, so the caller falls back to the single-record migration. */
export function parseComputerList(raw: string | null | undefined): PairedDesktop[] | undefined {
  if (!raw) return undefined;
  try { return listSchema.parse(JSON.parse(raw)); } catch { return undefined; }
}

/** Serializes after validation; throws when the list does not fit the schema (more than MAX_COMPUTERS, or a bad record). */
export function serializeComputerList(list: PairedDesktop[]): string {
  return JSON.stringify(listSchema.parse(list));
}

/** The stored active id when it still names a computer in the list, otherwise the first computer. */
export function chooseActive(list: PairedDesktop[], activeId: string | null | undefined): string | undefined {
  return list.some(d => d.desktopServiceId === activeId) ? activeId as string : list[0]?.desktopServiceId;
}

/** The one-time migration from the single-desktop record: one computer, made active. */
export function migrateSingle(single: PairedDesktop): ComputerList {
  return { list: [single], activeId: single.desktopServiceId };
}

/** Adds or replaces one computer (same desktopServiceId re-pairs); the new one becomes active. */
export function upsertComputer(list: PairedDesktop[], paired: PairedDesktop): PairedDesktop[] {
  return [...list.filter(d => d.desktopServiceId !== paired.desktopServiceId), paired];
}

/** Rewrites one computer's record in place (its network address changed); undefined when it is not in the list. */
export function rewriteComputer(list: PairedDesktop[], paired: PairedDesktop): PairedDesktop[] | undefined {
  if (!list.some(d => d.desktopServiceId === paired.desktopServiceId)) return undefined;
  return list.map(d => d.desktopServiceId === paired.desktopServiceId ? paired : d);
}

/** Removes one computer; the next active is the first remaining when the active one went away, unchanged otherwise. */
export function removeComputer(list: PairedDesktop[], desktopServiceId: string, activeId?: string): ComputerList {
  const next = list.filter(d => d.desktopServiceId !== desktopServiceId);
  const nextActive = activeId === desktopServiceId ? next[0]?.desktopServiceId : activeId;
  return { list: next, activeId: nextActive };
}
