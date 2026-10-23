// Pure helpers for the Electron shell (shell/main.mjs). Kept free of electron imports so the
// desktop test suite can pin their behavior; shell/main.mjs wires the electron side (dialogs,
// notifications, shell.openPath) around these decisions.

export interface ShellTransferRecord {
  manifest: { transferId: string; name: string; sizeBytes: number; direction: 'to-desktop' | 'to-client' };
  state: string;
  nextOffset: number;
  updatedAt: number;
  owner: string;
  error?: string;
  sourcePath?: string;
}
export interface ShellFileRow {
  id: string; name: string; size: number; direction: 'to-desktop' | 'to-client'; state: string;
  progress: number; updatedAt: number; device: string; error?: string; path?: string;
}

// Builds the file list the window shows: newest first, capped, with a progress fraction and a
// local path only for transfers that actually completed onto this computer.
export function transferRows(records: Iterable<ShellTransferRecord>,
  destinationOf: (record: ShellTransferRecord) => string | undefined, limit = 100): ShellFileRow[] {
  const rows: ShellFileRow[] = [];
  for (const record of records) {
    const m = record.manifest;
    const row: ShellFileRow = { id: m.transferId, name: m.name, size: m.sizeBytes, direction: m.direction, state: record.state,
      progress: m.sizeBytes ? Math.min(1, record.nextOffset / m.sizeBytes) : (record.state === 'completed' ? 1 : 0),
      updatedAt: record.updatedAt, device: record.owner, error: record.error };
    if (record.state === 'completed' && m.direction === 'to-desktop') {
      const path = destinationOf(record);
      if (path) row.path = path;
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows.slice(0, limit);
}

// The page may only ever act on paths that belong to a known transfer record, never on text it
// typed itself: a completed incoming file's destination, or the source of an outgoing one.
export function knownPath(records: Iterable<ShellTransferRecord>,
  destinationOf: (record: ShellTransferRecord) => string | undefined, candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || !candidate) return undefined;
  for (const record of records) {
    if (record.state === 'completed' && record.manifest.direction === 'to-desktop'
      && destinationOf(record) === candidate) return candidate;
    if (record.manifest.direction === 'to-client' && record.sourcePath === candidate) return candidate;
  }
  return undefined;
}

// Transfers already finished when the app booted must not notify; only fresh terminal states do.
// `seen` is a Set of transfer ids remembered across snapshots; `seeded` starts false.
export function freshTerminalTransfers(rows: ShellFileRow[], seen: Set<string>, seeded: boolean): { fresh: ShellFileRow[]; seeded: boolean } {
  const fresh: ShellFileRow[] = [];
  for (const row of rows) {
    const done = row.state === 'completed' || row.state === 'cancelled' || row.state === 'failed' || row.state === 'expired';
    if (!done) continue;
    if (!seen.has(row.id)) { seen.add(row.id); if (seeded) fresh.push(row); }
  }
  return { fresh, seeded: true };
}

// Which system notification (if any) a freshly finished transfer deserves.
export function notificationFor(row: ShellFileRow): { title: string; body: string; reveal: boolean } | undefined {
  if (row.state === 'completed' && row.direction === 'to-desktop') {
    return { title: 'File received', body: `${row.name} is on this computer.`, reveal: Boolean(row.path) };
  }
  if (row.state === 'completed' && row.direction === 'to-client') {
    return { title: 'File delivered', body: `Your phone received ${row.name}.`, reveal: false };
  }
  if (row.state === 'failed' && row.direction === 'to-desktop') {
    return { title: 'File transfer failed', body: `${row.name} could not be received.`, reveal: false };
  }
  return undefined;
}
