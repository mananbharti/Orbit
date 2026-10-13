/** Environment for spawning Windows PowerShell 5.1 (powershell.exe). When Orbit is started from PowerShell 7, the inherited PSModulePath points at modules 5.1 cannot load and standard cmdlets fail, so drop it and let powershell.exe use its own default. */
export function windowsPowerShellEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { PSModulePath: _inherited, ...rest } = process.env;
  return { ...rest, ...extra };
}
