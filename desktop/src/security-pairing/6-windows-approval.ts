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

export function windowsApproval(spawnPrompt: PromptSpawn = defaultSpawn, timeoutMs = APPROVAL_TIMEOUT_MS): BiometricConfirmation {
  return { verify: (message, context) => new Promise<boolean>(resolve => {
    if (!message.type.startsWith('input.')) { resolve(false); return; } // this prompt only ever approves remote control
    const device = context.session.deviceId.slice(0, 8);
    let child: ChildProcessWithoutNullStreams;
    let out = ''; let done = false;
    const finish = (v: boolean): void => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* already gone */ } resolve(v); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try { child = spawnPrompt(`Allow your phone (device ${device}) to move the mouse and type on this computer?\n\nChoose No unless you just started this on your phone.`); }
    catch { clearTimeout(timer); resolve(false); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { out += c; if (out.length > 64) finish(false); else if (out.includes('\n')) finish(out.trim() === 'ALLOW'); });
    child.on('error', () => finish(false)); child.on('exit', () => finish(out.trim() === 'ALLOW'));
  }) };
}
