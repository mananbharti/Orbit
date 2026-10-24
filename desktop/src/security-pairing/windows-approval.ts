/** Asks the person at the Windows PC to allow remote control, via a topmost Yes/No dialog that defaults to No; UNTESTED ON A REAL WINDOWS PC. Any error, timeout or close means deny. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BiometricConfirmation } from './biometric-confirmation.js';
import { windowsPowerShellEnv } from '../os-integration/powershell-env.js';

export const APPROVAL_TIMEOUT_MS = 30_000;
const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form; $form.TopMost = $true
$r = [System.Windows.Forms.MessageBox]::Show($form, $env:ORBIT_PROMPT_TEXT, 'Orbit', 'YesNo', 'Warning', 'Button2')
[Console]::WriteLine($(if ($r -eq 'Yes') { 'ALLOW' } else { 'DENY' }))
`;
export type PromptSpawn = (text: string) => ChildProcessWithoutNullStreams;
const defaultSpawn: PromptSpawn = text => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT],
  { windowsHide: false, stdio: 'pipe', env: windowsPowerShellEnv({ ORBIT_PROMPT_TEXT: text }) });

export function windowsApproval(spawnPrompt: PromptSpawn = defaultSpawn, timeoutMs = APPROVAL_TIMEOUT_MS,
  family: 'input' | 'terminal' | 'power' = 'input'): BiometricConfirmation {
  return { verify: (message, context) => new Promise<boolean>(resolve => {
    if (family === 'power' ? message.type !== 'system.power' : !message.type.startsWith(family + '.')) { resolve(false); return; } // one prompt approves exactly one family
    const device = context.session.deviceId.slice(0, 8);
    let child: ChildProcessWithoutNullStreams;
    let out = ''; let done = false;
    const finish = (v: boolean): void => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* already gone */ } resolve(v); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const text = family === 'terminal'
      ? `Allow your phone (device ${device}) to run commands on this computer? Commands can change or delete anything.\n\nChoose No unless you just started this on your phone.`
      : `Allow your phone (device ${device}) to move the mouse and type on this computer?\n\nChoose No unless you just started this on your phone.`;
    try { child = spawnPrompt(text); }
    catch { clearTimeout(timer); resolve(false); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { out += c; if (out.length > 64) finish(false); else if (out.includes('\n')) finish(out.trim() === 'ALLOW'); });
    child.on('error', () => finish(false)); child.on('exit', () => finish(out.trim() === 'ALLOW'));
  }) };
}
