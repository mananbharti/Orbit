/** Loads and saves the desktop app's Hermes gateway settings; depends on fs and an injected
 *  OS-backed encryptor (Electron safeStorage in the app, a fake in tests). The key is never
 *  written or returned in plaintext: the file holds only the encrypted blob. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export interface AgentConfig { apiKey: string; baseUrl?: string }

/** Checks a pasted key and optional gateway URL; throws with a user-readable reason. */
export function validateAgentConfig(input: { apiKey?: unknown; baseUrl?: unknown }): AgentConfig {
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey) throw new Error('Paste the API_SERVER_KEY from your Hermes setup.');
  if (/[\r\n]/.test(apiKey)) throw new Error('The API key must be a single line.');
  if (apiKey.length > 512) throw new Error('That API key looks too long.');
  let baseUrl: string | undefined;
  if (typeof input.baseUrl === 'string' && input.baseUrl.trim()) {
    const raw = input.baseUrl.trim();
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('The gateway address is not a valid URL.'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The gateway address must be http or https.');
    baseUrl = raw;
  }
  return baseUrl ? { apiKey, baseUrl } : { apiKey };
}

interface AgentConfigFile { v: number; key: string; baseUrl?: string }

/** Reads the saved settings; undefined when there is no file, it is corrupt, or decryption fails
 *  (for example the OS keychain locked) - the app then simply runs with agent tasks off. */
export function loadAgentConfig(path: string, decrypt: (blob: string) => string): AgentConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentConfigFile>;
    if (raw.v !== 1 || typeof raw.key !== 'string' || !raw.key) return undefined;
    const apiKey = decrypt(raw.key);
    return validateAgentConfig({ apiKey, ...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}) });
  } catch { return undefined; }
}

/** Saves settings encrypted; the plaintext key exists only in memory. */
export function saveAgentConfig(path: string, config: AgentConfig, encrypt: (plaintext: string) => string): void {
  const checked = validateAgentConfig(config);
  const file: AgentConfigFile = { v: 1, key: encrypt(checked.apiKey), ...(checked.baseUrl ? { baseUrl: checked.baseUrl } : {}) };
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
}

export function clearAgentConfig(path: string): void { rmSync(path, { force: true }); }
