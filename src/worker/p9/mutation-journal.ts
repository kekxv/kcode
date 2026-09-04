import { getJournalKey } from '../../security/journal-key';

export const MAX_JOURNAL_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_JOURNAL_TRANSACTION_BYTES = 100 * 1024 * 1024;

export type JournalEntrySummary = { path: string; operation: 'create' | 'write' | 'delete' | 'rename'; originalBytes: number; resultingBytes: number };
export type JournalSummary = { transactionId: string; state: 'clean' | 'dirty' | 'needs-rollback' | 'conflict'; entries: readonly JournalEntrySummary[]; journalBytes: number; writtenBytes: number };
export type JournalOriginal = { exists: boolean; bytes?: Uint8Array; lastModified?: number; size?: number };
export type JournalRecord = { path: string; operation: JournalEntrySummary['operation']; original: JournalOriginal; resultingBytes: number };
export type JournalStorage = { put(name: string, bytes: Uint8Array): Promise<void>; get(name: string): Promise<Uint8Array | null>; remove(name: string): Promise<void>; list(): Promise<string[]>; clear(): Promise<void> };
type EncryptedRecord = { iv: Uint8Array; ciphertext: Uint8Array };

const encoder = new TextEncoder(); const decoder = new TextDecoder();
const asBase64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value));
const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const context = (transactionId: string, entryId: number): Uint8Array => encoder.encode(JSON.stringify({ transactionId, entryId, schemaVersion: 1 }));
const nameFor = (entryId: number): string => `entry-${entryId}.bin`;

/** Minimal durable-storage double used only for tests. */
export class MemoryJournalStorage implements JournalStorage {
  private readonly values = new Map<string, Uint8Array>();
  async put(name: string, bytes: Uint8Array): Promise<void> { this.values.set(name, new Uint8Array(bytes)); }
  async get(name: string): Promise<Uint8Array | null> { const value = this.values.get(name); return value ? new Uint8Array(value) : null; }
  async remove(name: string): Promise<void> { this.values.delete(name); }
  async list(): Promise<string[]> { return [...this.values.keys()]; }
  async clear(): Promise<void> { this.values.clear(); }
  bytes(): Uint8Array[] { return [...this.values.values()].map((value) => new Uint8Array(value)); }
}

/** OPFS transaction directory; records are encrypted before reaching this store. */
export class OpfsJournalStorage implements JournalStorage {
  private constructor(private readonly directory: FileSystemDirectoryHandle) {}
  static async open(transactionId: string): Promise<OpfsJournalStorage> {
    const storage = (navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> }).getDirectory;
    if (!storage) throw new Error('JOURNAL_STORAGE_UNAVAILABLE');
    const root = await storage.call(navigator.storage);
    const journal = await root.getDirectoryHandle('kcode-journal', { create: true });
    return new OpfsJournalStorage(await journal.getDirectoryHandle(transactionId, { create: true }));
  }
  async put(name: string, bytes: Uint8Array): Promise<void> { const file = await this.directory.getFileHandle(name, { create: true }); const writable = await file.createWritable(); await writable.write(bytes as unknown as FileSystemWriteChunkType); await writable.close(); }
  async get(name: string): Promise<Uint8Array | null> { try { const file = await this.directory.getFileHandle(name); return new Uint8Array(await (await file.getFile()).arrayBuffer()); } catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return null; throw error; } }
  async remove(name: string): Promise<void> { await this.directory.removeEntry(name); }
  async list(): Promise<string[]> { const values: string[] = []; for await (const [name] of (this.directory as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) values.push(name); return values; }
  async clear(): Promise<void> { for (const name of await this.list()) await this.directory.removeEntry(name, { recursive: true }); }
}

/** Encrypted, bounded rollback journal. OPFS adapters supply the durable storage in production. */
export class MutationJournal {
  private readonly entries: JournalEntrySummary[] = [];
  private readonly records: Array<{ id: number; record: JournalRecord }> = [];
  private state: JournalSummary['state'] = 'clean';
  private journalBytes = 0;
  private writtenBytes = 0;
  private constructor(readonly transactionId: string, private readonly storage: JournalStorage, private readonly key: CryptoKey) {}

  static async begin(transactionId: string, storage: JournalStorage, key: CryptoKey | Promise<CryptoKey> = getJournalKey()): Promise<MutationJournal> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(transactionId)) throw new Error('INVALID_TRANSACTION_ID');
    return new MutationJournal(transactionId, storage, await key);
  }
  summary(): JournalSummary { return { transactionId: this.transactionId, state: this.state, entries: [...this.entries], journalBytes: this.journalBytes, writtenBytes: this.writtenBytes }; }
  markNeedsRollback(): void { if (this.state === 'dirty') this.state = 'needs-rollback'; }

  async record(record: JournalRecord): Promise<void> {
    if (this.state === 'needs-rollback' || this.state === 'conflict') throw new Error('JOURNAL_NOT_MUTABLE');
    if (this.records.some((entry) => entry.record.path === record.path)) return;
    const original = record.original.bytes ?? new Uint8Array();
    if (original.byteLength > MAX_JOURNAL_FILE_BYTES || record.resultingBytes > MAX_JOURNAL_FILE_BYTES) throw new Error('JOURNAL_FILE_LIMIT');
    if (this.writtenBytes + record.resultingBytes > MAX_JOURNAL_TRANSACTION_BYTES) throw new Error('JOURNAL_TRANSACTION_LIMIT');
    const id = this.records.length + 1;
    const plaintext = encoder.encode(JSON.stringify({ ...record, original: { ...record.original, bytes: asBase64(original) } }));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: context(this.transactionId, id) as unknown as BufferSource }, this.key, plaintext));
    const envelope = encoder.encode(JSON.stringify({ iv: asBase64(iv), ciphertext: asBase64(ciphertext) }));
    if (this.journalBytes + envelope.byteLength > MAX_JOURNAL_TRANSACTION_BYTES) throw new Error('JOURNAL_TRANSACTION_LIMIT');
    await this.storage.put(nameFor(id), envelope);
    this.records.push({ id, record: { ...record, original: { ...record.original, bytes: original } } });
    this.entries.push({ path: record.path, operation: record.operation, originalBytes: original.byteLength, resultingBytes: record.resultingBytes });
    this.journalBytes += envelope.byteLength; this.writtenBytes += record.resultingBytes; this.state = 'dirty';
  }

  async commit(): Promise<void> { if (this.state === 'conflict') throw new Error('WORKSPACE_CONFLICT'); await this.storage.clear(); this.state = 'clean'; }
  async rollback(restore: (path: string, original: JournalOriginal) => Promise<void>): Promise<void> { if (this.state === 'conflict') throw new Error('WORKSPACE_CONFLICT'); for (const { id } of [...this.records].reverse()) { const encrypted = await this.storage.get(nameFor(id)); if (!encrypted) throw new Error('JOURNAL_TAMPERED'); const record = await this.decrypt(id, encrypted); await restore(record.path, record.original); } await this.storage.clear(); this.state = 'clean'; }
  async recover(restore: (path: string, original: JournalOriginal) => Promise<void>): Promise<void> { await this.rollback(restore); }

  private async decrypt(id: number, bytes: Uint8Array): Promise<JournalRecord> {
    try { const parsed = JSON.parse(decoder.decode(bytes)) as { iv: string; ciphertext: string }; const iv = fromBase64(parsed.iv); const ciphertext = fromBase64(parsed.ciphertext); const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: context(this.transactionId, id) as unknown as BufferSource }, this.key, ciphertext as unknown as BufferSource); const parsedRecord = JSON.parse(decoder.decode(plaintext)) as JournalRecord & { original: Omit<JournalOriginal, 'bytes'> & { bytes: string } }; return { ...parsedRecord, original: { ...parsedRecord.original, bytes: fromBase64(parsedRecord.original.bytes) } }; } catch { this.state = 'conflict'; throw new Error('JOURNAL_TAMPERED'); }
  }
}
