/** Privately persisted keyboard macros (named saved key chords); depends on private atomic storage; a corrupt file starts empty. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from '../security-pairing/atomic-file.js';
import { MAX_MACROS, keyboardMacroSchema, type KeyboardMacro } from '../protocol/input.js';

export class KeyboardMacroStore {
  private macros: KeyboardMacro[] = [];

  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const parsed = z.array(keyboardMacroSchema).max(MAX_MACROS).safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) this.macros = parsed.data;
    } catch { /* unreadable macros are simply forgotten */ }
  }

  list(): KeyboardMacro[] { return this.macros.map(macro => ({ ...macro, steps: macro.steps.map(step => ({ ...step })) })); }

  /** Creates without an id, replaces with one. Names dedupe case-insensitively so twins cannot exist. */
  save(name: string, steps: KeyboardMacro['steps'], id?: string): KeyboardMacro[] {
    const clash = this.macros.find(macro => macro.name.toLowerCase() === name.toLowerCase() && macro.id !== id);
    if (clash) throw new Error('INPUT_MACRO_NAME_TAKEN');
    if (id) {
      const index = this.macros.findIndex(macro => macro.id === id);
      if (index === -1) throw new Error('INPUT_MACRO_NOT_FOUND');
      this.macros[index] = { id, name, steps: steps.map(step => ({ ...step })) };
    } else {
      if (this.macros.length >= MAX_MACROS) throw new Error('INPUT_MACRO_LIMIT');
      this.macros.push({ id: randomUUID(), name, steps: steps.map(step => ({ ...step })) });
    }
    this.persist();
    return this.list();
  }

  remove(id: string): KeyboardMacro[] {
    const next = this.macros.filter(macro => macro.id !== id);
    if (next.length !== this.macros.length) { this.macros = next; this.persist(); }
    return this.list();
  }

  private persist(): void { if (this.path) atomicWrite(this.path, JSON.stringify(this.macros)); }
}
