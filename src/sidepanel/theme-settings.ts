export type ThemeMode = 'system' | 'light' | 'dark';
type StorageArea = { get(keys: string | string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
const KEY = 'kcode.theme';
const valid = (value: unknown): value is ThemeMode => value === 'system' || value === 'light' || value === 'dark';
export const effectiveTheme = (mode: ThemeMode, systemDark: boolean): 'light' | 'dark' => mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
export class ThemeSettingsStore {
  constructor(private readonly storage: StorageArea = chrome.storage.sync) {}
  async load(): Promise<ThemeMode> { try { const value = (await this.storage.get(KEY))[KEY]; return valid(value) ? value : 'system'; } catch { return 'system'; } }
  async save(mode: ThemeMode): Promise<ThemeMode> { const safe = valid(mode) ? mode : 'system'; await this.storage.set({ [KEY]: safe }); return safe; }
}
