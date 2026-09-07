/** Discovers Start menu registrations and asks Windows Shell to activate one; depends on PowerShell/COM; never interpolates app data into scripts or requests elevation. */
import { z } from 'zod';
import { MAX_APPS } from '../protocol/app-launcher.js';
import type { AppLauncherAdapter, NativeApp } from './app-launcher.js';
import { runLauncherTool, type LauncherTool } from './launcher-tool.js';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::ReadLine() | ConvertFrom-Json
$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace('shell:AppsFolder')
if ($null -eq $folder) { exit 2 }
$registered = @{}
foreach ($app in @(Get-StartApps)) { $registered[$app.AppID] = $true }
$entries = @()
$selected = $null
foreach ($item in $folder.Items()) {
  $key = [string]$item.Path
  if (-not $registered.ContainsKey($key)) { continue }
  if ($request.action -eq 'launch' -and $key -cne $request.key) { continue }
  $target = [string]$item.ExtendedProperty('System.Link.TargetParsingPath')
  $arguments = [string]$item.ExtendedProperty('System.Link.Arguments')
  $descriptor = @([string]$item.Name, $key, $target, $arguments) | ConvertTo-Json -Compress
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { $revision = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($descriptor)))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
  $entries += @{ key = $key; name = [string]$item.Name; revision = $revision }
  if ($entries.Count -gt 2048) { exit 2 }
  if ($request.action -eq 'launch' -and $key -ceq $request.key -and $revision -ceq $request.revision) { $selected = $item }
}
if ($request.action -eq 'list') { [Console]::Write((ConvertTo-Json -InputObject $entries -Compress)); exit 0 }
if ($request.action -ne 'launch' -or $null -eq $selected) { exit 3 }
[Console]::Write("READY" + [char]10)
if ([Console]::ReadLine() -cne 'GO') { exit 2 }
$selected.InvokeVerb('open')
exit 0
`;
const entriesSchema = z.array(z.strictObject({ key: z.string().min(1).max(4_096), name: z.string().max(4_096),
  revision: z.string().regex(/^[a-f0-9]{64}$/) })).max(MAX_APPS);
export class WindowsAppLauncher implements AppLauncherAdapter {
  constructor(private readonly run: LauncherTool = runLauncherTool) {}
  async list(signal: AbortSignal): Promise<NativeApp[]> {
    return entriesSchema.parse(JSON.parse(await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT],
      { signal, input: JSON.stringify({ action: 'list' }) })));
  }
  async launch(app: NativeApp, authorize: () => void, signal: AbortSignal): Promise<void> {
    await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT],
      { signal, input: JSON.stringify({ action: 'launch', key: app.key, revision: app.revision }), authorize, activation: true });
  }
}
