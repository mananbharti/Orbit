/** Bridges the Windows clipboard through one STA PowerShell worker; depends on .NET Forms; never puts clipboard data in arguments, files, or logs. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { clipboardSnapshotSchema, clipboardTextSchema, MAX_CLIPBOARD_BYTES, type ClipboardSnapshot } from '../protocol/clipboard.js';
import { ClipboardUnavailable, type ClipboardAdapter } from './clipboard.js';

const WORKER_TIMEOUT_MS = 5_000;
const MAX_WORKER_RESPONSE_BYTES = 64 * 1_024;
const WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = ConvertFrom-Json -InputObject $line
    if ($request.op -eq 'read') {
      $data = [System.Windows.Forms.Clipboard]::GetDataObject()
      $blocked = $false
      if ($null -ne $data) {
        foreach ($format in @('FileDrop', 'Bitmap', 'Rich Text Format', 'HTML Format')) {
          if ($data.GetDataPresent($format, $false)) { $blocked = $true }
        }
      }
      if ($null -eq $data -or $blocked -or !$data.GetDataPresent('UnicodeText', $false)) {
        $result = @{ kind = 'unsupported' }
      } else {
        $text = [string]$data.GetData('UnicodeText', $false)
        if ([System.Text.Encoding]::UTF8.GetByteCount($text) -gt ${MAX_CLIPBOARD_BYTES}) {
          $result = @{ kind = 'oversized' }
        } else { $result = @{ kind = 'text'; text = $text } }
      }
    } elseif ($request.op -eq 'write') {
      $data = New-Object System.Windows.Forms.DataObject
      $data.SetData('UnicodeText', $false, [string]$request.text)
      [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
      $result = @{ written = $true }
    } else { throw 'Invalid operation' }
    [Console]::WriteLine((ConvertTo-Json -InputObject $result -Compress))
  } catch { [Console]::WriteLine('{"unavailable":true}') }
  $request = $null; $result = $null; $data = $null; $text = $null; $line = $null
}
`;

export class WindowsClipboard implements ClipboardAdapter {
  private worker?: ChildProcessWithoutNullStreams;
  private disposed = false;
  private pending?: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private output = '';

  async read(): Promise<ClipboardSnapshot> {
    const response = await this.request({ op: 'read' });
    if (response && typeof response === 'object' && 'kind' in response && response.kind === 'text'
      && 'text' in response && typeof response.text === 'string' && !clipboardTextSchema.safeParse(response.text).success) {
      return { kind: 'unsupported' };
    }
    const parsed = clipboardSnapshotSchema.safeParse(response);
    if (!parsed.success) throw new ClipboardUnavailable();
    return parsed.data;
  }

  async write(text: string): Promise<void> {
    if (!clipboardTextSchema.safeParse(text).success) throw new ClipboardUnavailable();
    const response = await this.request({ op: 'write', text });
    if (!response || typeof response !== 'object' || !('written' in response) || response.written !== true) {
      throw new ClipboardUnavailable();
    }
  }

  async dispose(): Promise<void> { this.disposed = true; this.fail(); }

  private request(value: object): Promise<unknown> {
    if (this.disposed || this.pending) return Promise.reject(new ClipboardUnavailable());
    if (!this.worker) {
      const worker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', WORKER_SCRIPT],
        { windowsHide: true, stdio: 'pipe' });
      this.worker = worker;
      worker.stdout.setEncoding('utf8');
      worker.stdout.on('data', (chunk: string) => {
        if (worker !== this.worker) return;
        this.output += chunk;
        if (Buffer.byteLength(this.output) > MAX_WORKER_RESPONSE_BYTES) { this.fail(); return; }
        const newline = this.output.indexOf('\n');
        if (newline < 0) return;
        const line = this.output.slice(0, newline);
        this.output = this.output.slice(newline + 1);
        const pending = this.pending;
        if (!pending || this.output.trim()) { this.fail(); return; }
        try {
          const response: unknown = JSON.parse(line);
          clearTimeout(pending.timer);
          this.pending = undefined;
          this.output = '';
          pending.resolve(response);
        } catch { this.fail(); }
      });
      worker.stderr.resume();
      worker.stdin.on('error', () => { if (worker === this.worker) this.fail(); });
      worker.on('error', () => { if (worker === this.worker) this.fail(); });
      worker.on('exit', () => { if (worker === this.worker) this.fail(); });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), WORKER_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      this.worker!.stdin.write(`${JSON.stringify(value)}\n`, 'utf8', error => { if (error) this.fail(); });
    });
  }

  private fail(): void {
    const worker = this.worker;
    this.worker = undefined;
    worker?.kill();
    this.output = '';
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(new ClipboardUnavailable());
    this.pending = undefined;
  }
}
