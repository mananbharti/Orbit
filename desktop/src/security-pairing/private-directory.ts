/** Creates owner-only local storage; depends on OS filesystem/ACL tools; never changes permissions on an existing directory. */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  const created = !existsSync(absolute);
  if (created) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()
    || realpathSync(absolute).toLowerCase() !== absolute.toLowerCase()) throw new Error('Unsafe data directory');
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
$path = $env:ORBIT_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:ORBIT_PRIVATE_CREATED -eq '1') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
}
$current = Get-Acl -LiteralPath $path
if ($current.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Wrong owner' }
foreach ($rule in $current.Access) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Data directory is not private' }
}
`;
    // When Orbit is started from PowerShell 7, its PSModulePath points at modules Windows PowerShell 5.1 cannot load (Set-Acl then fails). Let powershell.exe use its own default.
    const { PSModulePath: _inherited, ...baseEnv } = process.env;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...baseEnv, ORBIT_PRIVATE_PATH: absolute, ORBIT_PRIVATE_CREATED: created ? '1' : '0' },
        windowsHide: true, stdio: 'pipe', timeout: 30_000 });
  } else {
    const stat = lstatSync(absolute);
    if (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error('Data directory is not private');
  }
  return absolute;
}
