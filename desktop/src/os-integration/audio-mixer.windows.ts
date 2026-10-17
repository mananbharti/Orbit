/** Per-app volume on Windows through Core Audio sessions in a bounded PowerShell worker; depends on powershell.exe; never interpolates user data into scripts. */
import { execFile } from 'node:child_process';
import type { AudioMixerAdapter, AudioSession } from './audio-mixer.js';
import { AudioMixerUnavailable } from './audio-mixer.js';
import { windowsPowerShellEnv } from './powershell-env.js';

const TIMEOUT_MS = 10_000;
function ps(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: TIMEOUT_MS, windowsHide: true, env: windowsPowerShellEnv(), maxBuffer: 1 << 20 },
      (error, stdout) => { if (error) reject(new AudioMixerUnavailable(String(error.message).slice(0, 120))); else resolve(String(stdout).trim()); });
  });
}

// Enumerates IAudioSessionManager2 sessions on the default endpoint; volume/mute via ISimpleAudioVolume, app name via the owning process.
const MIXER_CSHARP = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 { int NotImpl0(); int GetSessionEnumerator(out IntPtr enumerator); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { int GetCount(out int count); int GetSession(int index, out IntPtr session); }
[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl { int GetState(out int state); int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 { int NotImpl0(); int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4(); int NotImpl5(); int NotImpl6(); int NotImpl7();
  int GetProcessId(out uint pid); }
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume { int SetMasterVolume(float level, Guid eventContext); int GetMasterVolume(out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext); int GetMute(out bool mute); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
public class MixSession { public uint Pid; public string Name = ""; public int Volume; public bool Muted; }
public static class Mixer {
  static IntPtr Sessions() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid iid = typeof(IAudioSessionManager2).GUID; object o; dev.Activate(ref iid, 1, IntPtr.Zero, out o);
    IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
    IntPtr en; mgr.GetSessionEnumerator(out en); return en; }
  public static List<MixSession> List() {
    var result = new List<MixSession>();
    var en = (IAudioSessionEnumerator)Marshal.GetObjectForIUnknown(Sessions());
    int count; en.GetCount(out count);
    for (int i = 0; i < count; i++) {
      IntPtr ptr; en.GetSession(i, out ptr);
      var ctl2 = (IAudioSessionControl2)Marshal.GetObjectForIUnknown(ptr);
      var vol = (ISimpleAudioVolume)Marshal.GetObjectForIUnknown(ptr);
      uint pid; if (ctl2.GetProcessId(out pid) != 0 || pid == 0) continue;
      float level; vol.GetMasterVolume(out level); bool mute; vol.GetMute(out mute);
      string name; try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { name = "System"; }
      result.Add(new MixSession { Pid = pid, Name = name, Volume = (int)Math.Round(level * 100), Muted = mute }); }
    return result; }
  public static bool Set(uint pid, float level, bool mute, bool setLevel, bool setMute) {
    var en = (IAudioSessionEnumerator)Marshal.GetObjectForIUnknown(Sessions());
    int count; en.GetCount(out count);
    for (int i = 0; i < count; i++) {
      IntPtr ptr; en.GetSession(i, out ptr);
      var ctl2 = (IAudioSessionControl2)Marshal.GetObjectForIUnknown(ptr);
      uint sessionPid; if (ctl2.GetProcessId(out sessionPid) != 0 || sessionPid != pid) continue;
      var vol = (ISimpleAudioVolume)Marshal.GetObjectForIUnknown(ptr);
      if (setLevel) vol.SetMasterVolume(level, Guid.Empty);
      if (setMute) vol.SetMute(mute, Guid.Empty);
      return true; }
    return false; }
}
'@
`;

export class WindowsAudioMixer implements AudioMixerAdapter {
  async listSessions(): Promise<AudioSession[]> {
    const out = await ps(MIXER_CSHARP + `
[Mixer]::List() | ForEach-Object { [Console]::WriteLine(('{0}|{1}|{2}|{3}' -f $_.Pid, ($_.Name -replace '[|]', ''), $_.Volume, $_.Muted)) }`);
    if (!out) return [];
    const sessions: AudioSession[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\d{1,10})\|([^|]{1,128})\|(\d{1,3})\|(True|False)$/.exec(line);
      if (m) sessions.push({ id: m[1]!, name: m[2]!, volume: Math.min(100, Number(m[3])), muted: m[4] === 'True' });
    }
    return sessions;
  }
  async setSession(id: string, level?: number, muted?: boolean): Promise<void> {
    if (!/^[0-9]{1,10}$/.test(id)) throw new AudioMixerUnavailable('Invalid session id');
    if (level !== undefined && (!Number.isInteger(level) || level < 0 || level > 100)) throw new AudioMixerUnavailable('Volume must be 0-100');
    // Values cross as typed PowerShell literals, never string-interpolated user data: id is digits-only, level is a bounded int, mute is a boolean switch.
    const out = await ps(MIXER_CSHARP + `
$ok = [Mixer]::Set([uint32]${id}, [float]${level ?? 0}, [bool]$${muted ? 'True' : 'False'}, [bool]$${level !== undefined}, [bool]$${muted !== undefined})
if ($ok) { [Console]::Write('ok') } else { [Console]::Write('gone') }`);
    if (out !== 'ok') throw new AudioMixerUnavailable('That app is no longer playing audio');
  }
}
