/** Windows power/volume/brightness through bounded PowerShell workers; depends on powershell.exe; never interpolates user data into scripts. */
import { execFile } from 'node:child_process';
import type { SystemControlAdapter } from './system-control.js';
import { SystemControlUnavailable } from './system-control.js';
import { windowsPowerShellEnv } from './powershell-env.js';

const TIMEOUT_MS = 10_000;
function run(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, env: windowsPowerShellEnv(), maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) reject(new SystemControlUnavailable(String(error.message).slice(0, 120)));
      else resolve(String(stdout).trim());
    }).stdin?.end(input ?? '');
  });
}
const ps = (script: string, input?: string): Promise<string> => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);

// Master volume through the Core Audio COM API; the classic C# interop, compiled in-proc by PowerShell.
const VOLUME_CSHARP = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int NotImpl0(); int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4(); int NotImpl5(); int NotImpl6(); int NotImpl7();
  int GetChannelCount(out int n); int SetMasterVolumeLevel(float level, Guid eventContext); int SetMasterVolumeLevelScalar(float level, Guid eventContext);
  int GetMasterVolumeLevel(out float level); int GetMasterVolumeLevelScalar(out float level); int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext);
  int GetMute(out bool mute); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
public static class Audio {
  public static IAudioEndpointVolume Endpoint() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid iid = typeof(IAudioEndpointVolume).GUID; object o; dev.Activate(ref iid, 1, IntPtr.Zero, out o);
    return (IAudioEndpointVolume)o; }
}
'@
`;

export class WindowsSystemControl implements SystemControlAdapter {
  async power(action: 'lock' | 'sleep' | 'restart' | 'shutdown'): Promise<void> {
    if (action === 'lock') { await run('rundll32.exe', ['user32.dll,LockWorkStation']); return; }
    if (action === 'sleep') { await run('rundll32.exe', ['powrprof.dll,SetSuspendState', 'Sleep']); return; }
    await run('shutdown.exe', action === 'restart' ? ['/r', '/t', '3'] : ['/s', '/t', '3']);
  }
  async getVolume(): Promise<{ level: number; muted: boolean }> {
    const out = await ps(VOLUME_CSHARP + `
$v = [Audio]::Endpoint()
$level = 0.0; $mute = $false
[void]$v.GetMasterVolumeLevelScalar([ref]$level); [void]$v.GetMute([ref]$mute)
[Console]::Write(('{0};{1}' -f [int][Math]::Round($level * 100), $mute))`);
    const m = /^(\d{1,3});(True|False)$/.exec(out);
    if (!m) throw new SystemControlUnavailable('Could not read the master volume');
    return { level: Math.min(100, Number(m[1])), muted: m[2] === 'True' };
  }
  async setVolume(level: number, muted?: boolean): Promise<void> {
    if (!Number.isInteger(level) || level < 0 || level > 100) throw new SystemControlUnavailable('Volume must be 0-100');
    await ps(VOLUME_CSHARP + `
$v = [Audio]::Endpoint()
[void]$v.SetMasterVolumeLevelScalar([float](${'LEVEL'} / 100.0), [Guid]::Empty)
${'MUTE'}`.replace('LEVEL', String(level)).replace('MUTE', typeof muted === 'boolean' ? `[void]$v.SetMute($${muted}, [Guid]::Empty)` : ''));
  }
  async getBrightness(): Promise<number | null> {
    const out = await ps(`(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue).CurrentBrightness`);
    const n = Number(out);
    return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
  }
  async setBrightness(level: number): Promise<void> {
    if (!Number.isInteger(level) || level < 0 || level > 100) throw new SystemControlUnavailable('Brightness must be 0-100');
    await ps(`$m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue; if ($null -eq $m) { exit 3 }; $m.WmiSetBrightness(1, ${'LEVEL'})`.replace('LEVEL', String(level)));
  }
}
