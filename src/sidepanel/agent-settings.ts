const SETTINGS_KEY = 'kcode.agent-instructions';
const MAX_INSTRUCTION_BYTES = 16 * 1024;
const encoder = new TextEncoder();

type LocalStorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

const validate = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('AGENT_INSTRUCTIONS_INVALID');
  if (encoder.encode(value).byteLength > MAX_INSTRUCTION_BYTES) throw new Error('AGENT_INSTRUCTIONS_TOO_LARGE');
  return value;
};

/** Local, user-authored preferences; they never grant tools, network, or consent. */
export class AgentSettingsStore {
  constructor(private readonly storage: LocalStorageArea = chrome.storage.local) {}

  async load(): Promise<string> {
    const value = (await this.storage.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (value === undefined) return '';
    try { return validate(value); } catch { await this.storage.remove(SETTINGS_KEY); return ''; }
  }

  async save(value: string): Promise<string> {
    const valid = validate(value);
    await this.storage.set({ [SETTINGS_KEY]: valid });
    return valid;
  }

  async clear(): Promise<void> { await this.storage.remove(SETTINGS_KEY); }
}
