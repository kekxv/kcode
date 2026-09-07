export type ExecutionMode = 'confirm-each' | 'auto-write' | 'auto';
type StorageArea = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
const KEY = 'kcode.execution-mode';
const valid = (value: unknown): value is ExecutionMode => value === 'confirm-each' || value === 'auto-write' || value === 'auto';
/** Persist the selection, while execution authorization remains session-scoped. */
export class ExecutionSettingsStore {
  constructor(private readonly storage: StorageArea = chrome.storage.local) {}
  async load(): Promise<ExecutionMode> {
    try { const value = (await this.storage.get(KEY))[KEY]; return valid(value) ? value : 'confirm-each'; }
    catch { return 'confirm-each'; }
  }
  async save(mode: ExecutionMode): Promise<ExecutionMode> {
    if (!valid(mode)) throw new Error('EXECUTION_MODE_INVALID');
    await this.storage.set({ [KEY]: mode });
    return mode;
  }
}
