import { validateRelayUrl } from '../worker/network-config';

type LocalStorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

const RELAY_URL_KEY = 'kcode.wisp-relay-url';

/** Trusted-context durable relay configuration. Risk consent remains session-only. */
export class RelaySettingsStore {
  constructor(private readonly storage: LocalStorageArea = chrome.storage.local) {}

  async load(): Promise<string | null> {
    const value = (await this.storage.get(RELAY_URL_KEY))[RELAY_URL_KEY];
    if (value === undefined) return null;
    try {
      if (typeof value !== 'string') throw new Error('INVALID_RELAY_URL');
      return validateRelayUrl(value).websocketUrl;
    } catch {
      await this.storage.remove(RELAY_URL_KEY);
      return null;
    }
  }

  async save(input: string): Promise<string> {
    const normalized = validateRelayUrl(input).websocketUrl;
    await this.storage.set({ [RELAY_URL_KEY]: normalized });
    return normalized;
  }

  async clear(): Promise<void> {
    await this.storage.remove(RELAY_URL_KEY);
  }
}
