/** Owner-run command: prints the agent audit trail as JSON or CSV; depends on the audit file in the private data directory; reads only, never contacts the phone. */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuditTrail } from './audit-trail.js';

const [dir, format = 'csv'] = process.argv.slice(2);
if (!dir || (format !== 'csv' && format !== 'json')) {
  console.error('Usage: node dist/src/agent/export-audit.js <private-data-directory> [csv|json]');
  process.exit(2);
}
const directory = resolve(dir);
if (!existsSync(join(directory, 'agent-audit.jsonl'))) { console.error('No agent audit log found in that directory.'); process.exit(1); }
process.stdout.write(new AuditTrail(directory).exportAll(format));
