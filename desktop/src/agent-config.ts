/** Loads and saves the desktop app's Hermes gateway settings; depends on fs and an injected
 *  OS-backed encryptor (Electron safeStorage in the app, a fake in tests). The key is never
 *  written or returned in plaintext: the file holds only the encrypted blob. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export interface FastModel { kind: 'ollama' | 'lmstudio'; baseUrl: string; model: string }
export interface AgentConfig { apiKey: string; baseUrl?: string; layaUrl?: string; fastModel?: FastModel }

/** The user's picked local model for fast answers; loopback only, model name bounded. */
function optionalFastModel(raw: unknown): FastModel | undefined {
  if (raw === undefined || raw === null) return undefined;
  const m = raw as Partial<FastModel>;
  if (m.kind !== 'ollama' && m.kind !== 'lmstudio') throw new Error('The fast-answer model must come from Ollama or LM Studio.');
  const baseUrl = optionalUrl(m.baseUrl, 'fast-answer server address');
  if (!baseUrl) throw new Error('The fast-answer server address is missing.');
  const host = new URL(baseUrl).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') throw new Error('The fast-answer server must be on this computer.');
  const model = typeof m.model === 'string' ? m.model.trim() : '';
  if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('Pick a model from the list.');
  return { kind: m.kind, baseUrl, model };
}

/** Optional http(s) URL; throws with a user-readable reason. */
function optionalUrl(raw: unknown, what: string): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim();
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`The ${what} is not a valid URL.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`The ${what} must be http or https.`);
  return value;
}

/** Checks a pasted key and optional gateway URL; throws with a user-readable reason. */
export function validateAgentConfig(input: { apiKey?: unknown; baseUrl?: unknown; layaUrl?: unknown; fastModel?: unknown }): AgentConfig {
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey) throw new Error('Paste the API_SERVER_KEY from your Hermes setup.');
  if (/[\r\n]/.test(apiKey)) throw new Error('The API key must be a single line.');
  if (apiKey.length > 512) throw new Error('That API key looks too long.');
  const baseUrl = optionalUrl(input.baseUrl, 'gateway address');
  const layaUrl = optionalUrl(input.layaUrl, 'decision model address');
  if (layaUrl) {
    const host = new URL(layaUrl).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]')
      throw new Error('The decision model address must point at this computer (127.0.0.1 or localhost) - Laya runs locally.');
  }
  const fastModel = optionalFastModel(input.fastModel);
  return { apiKey, ...(baseUrl ? { baseUrl } : {}), ...(layaUrl ? { layaUrl } : {}), ...(fastModel ? { fastModel } : {}) };
}

interface AgentConfigFile { v: number; key: string; baseUrl?: string; layaUrl?: string; fastModel?: FastModel }

/** Reads the saved settings; undefined when there is no file, it is corrupt, or decryption fails
 *  (for example the OS keychain locked) - the app then simply runs with agent tasks off. */
export function loadAgentConfig(path: string, decrypt: (blob: string) => string): AgentConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentConfigFile>;
    if (raw.v !== 1 || typeof raw.key !== 'string' || !raw.key) return undefined;
    const apiKey = decrypt(raw.key);
    return validateAgentConfig({ apiKey, ...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}), ...(typeof raw.layaUrl === 'string' ? { layaUrl: raw.layaUrl } : {}), ...(raw.fastModel && typeof raw.fastModel === 'object' ? { fastModel: raw.fastModel } : {}) });
  } catch { return undefined; }
}

/** Saves settings encrypted; the plaintext key exists only in memory. */
export function saveAgentConfig(path: string, config: AgentConfig, encrypt: (plaintext: string) => string): void {
  const checked = validateAgentConfig(config);
  const file: AgentConfigFile = { v: 1, key: encrypt(checked.apiKey), ...(checked.baseUrl ? { baseUrl: checked.baseUrl } : {}), ...(checked.layaUrl ? { layaUrl: checked.layaUrl } : {}), ...(checked.fastModel ? { fastModel: checked.fastModel } : {}) };
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
}

export function clearAgentConfig(path: string): void { rmSync(path, { force: true }); }
