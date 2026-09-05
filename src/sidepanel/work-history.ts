import type { ChatProvider } from '../types/protocol';

const KEY = 'kcode.work-history.v1';
const MAX_ENTRIES = 2_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const encoder = new TextEncoder();

type LocalStorageArea = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> };
export type WorkRecord = { id: string; createdAt: number; provider: ChatProvider; task: string; outcome: string; status: 'completed' | 'failed' };
const providers: readonly ChatProvider[] = ['DeepSeek', 'Qwen', 'Google AI Studio', 'ChatGPT', 'HIX.AI', 'Gemini', 'EaseMate'];
const valid = (value: unknown): value is WorkRecord => typeof value === 'object' && value !== null && Object.keys(value).length === 6
  && typeof (value as WorkRecord).id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test((value as WorkRecord).id)
  && Number.isSafeInteger((value as WorkRecord).createdAt) && (value as WorkRecord).createdAt >= 0
  && providers.includes((value as WorkRecord).provider) && typeof (value as WorkRecord).task === 'string' && typeof (value as WorkRecord).outcome === 'string'
  && encoder.encode((value as WorkRecord).task).byteLength <= MAX_TEXT_BYTES && encoder.encode((value as WorkRecord).outcome).byteLength <= MAX_TEXT_BYTES
  && ((value as WorkRecord).status === 'completed' || (value as WorkRecord).status === 'failed');

export class WorkHistoryStore {
  constructor(private readonly storage: LocalStorageArea = chrome.storage.local) {}
  async load(): Promise<readonly WorkRecord[]> { const value = (await this.storage.get(KEY))[KEY]; if (value === undefined) return []; if (!Array.isArray(value) || !value.every(valid)) { await this.storage.remove(KEY); return []; } return value; }
  async append(record: WorkRecord): Promise<readonly WorkRecord[]> { if (!valid(record)) throw new Error('WORK_HISTORY_INVALID'); const records = [record, ...(await this.load())]; while (records.length > MAX_ENTRIES || encoder.encode(JSON.stringify(records)).byteLength > MAX_BYTES) records.pop(); await this.storage.set({ [KEY]: records }); return records; }
  async clear(): Promise<void> { await this.storage.remove(KEY); }
}
