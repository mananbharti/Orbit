import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalService } from '../src/terminal/terminal-service.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import type { BiometricConfirmation } from '../src/security-pairing/biometric-confirmation.js';
import type { CommandContext, CommandConnection } from '../src/command-router/command-context.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}
const approve: BiometricConfirmation = { verify: async () => true };

test('cd ~ and cd ~/sub resolve against the home directory, like a real shell', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orbit-term-home-'));
  mkdirSync(join(home, 'Documents'));
  const conn: CommandConnection = { id: 'c', closed: new AbortController().signal, isAuthorized: () => true, publish: () => {} } as unknown as CommandConnection;
  const ctx: CommandContext = { session: { deviceId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', sessionId: 's', expiresAt: Date.now() + 60_000, version: 1 } as unknown as CommandContext['session'],
    requestId: 'r', connection: conn };
  const registry = new CommandRegistry();
  const service = new TerminalService(registry, new ActivityLog(), approve, () => new FakeChild().asChild(), home);
  const { sessionId } = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  const exec = registry.get('terminal.exec')!;
  const tilde = await exec.execute({ sessionId, command: 'cd ~' }, ctx) as { exitCode: number; cwd: string };
  assert.equal(tilde.exitCode, 0);
  assert.equal(tilde.cwd, home);
  const sub = await exec.execute({ sessionId, command: 'cd ~/Documents' }, ctx) as { exitCode: number; cwd: string };
  assert.equal(sub.exitCode, 0);
  assert.equal(sub.cwd, join(home, 'Documents'));
  const quoted = await exec.execute({ sessionId, command: 'cd "~"' }, ctx) as { exitCode: number; cwd: string };
  assert.equal(quoted.exitCode, 0);
  assert.equal(quoted.cwd, home);
  await service.stop();
  rmSync(home, { recursive: true, force: true });
});
