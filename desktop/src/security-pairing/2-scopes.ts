/** Maps command families to permission scopes; depends on nothing; does not authenticate or store anything. */
export const SCOPES = ['agent', 'clipboard', 'files', 'launcher', 'input', 'dictation', 'memory'] as const;
export type Scope = (typeof SCOPES)[number];

const FAMILY_SCOPE: Readonly<Record<string, Scope>> = { agent: 'agent', clipboard: 'clipboard', file: 'files', launcher: 'launcher', input: 'input', dictation: 'dictation', memory: 'memory' };

export function scopeForCommand(type: string): Scope | undefined { return FAMILY_SCOPE[type.split('.')[0] ?? '']; }

/** undefined scopes means a full-access device (every device paired before scopes existed). */
export function isCommandAllowed(scopes: readonly Scope[] | undefined, type: string): boolean {
  if (!scopes) return true;
  const needed = scopeForCommand(type);
  return needed !== undefined && scopes.includes(needed); // unknown families need full access: fail closed
}

export function parseScopes(value: string | undefined): Scope[] | undefined {
  if (value === undefined || value.trim() === '' || value.trim() === 'all') return undefined;
  const parts = value.split(',').map(part => part.trim());
  const scopes = parts.filter((part): part is Scope => (SCOPES as readonly string[]).includes(part));
  if (scopes.length !== parts.length || scopes.length === 0) throw new Error(`ORBIT_PAIR_SCOPES must be "all" or a list of: ${SCOPES.join(', ')}`);
  return [...new Set(scopes)];
}
