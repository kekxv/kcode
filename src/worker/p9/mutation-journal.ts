import { getJournalKey } from '../../security/journal-key';

export const MAX_JOURNAL_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_JOURNAL_TRANSACTION_BYTES = 100 * 1024 * 1024;

export type JournalEntrySummary = { path: string; operation: 'create' | 'write' | 'delete' | 'rename'; originalBytes: number; resultingBytes: number };
export type JournalSummary = { transactionId: string; state: 'clean' | 'dirty' | 'needs-rollback' | 'conflict'; entries: readonly JournalEntrySummary[]; journalBytes: number; writtenBytes: number };
export type JournalOriginal = { exists: boolean; kind?: FileSystemHandleKind; bytes?: Uint8Array; lastModified?: number; size?: number; sha256?: string };
export type JournalRecord = { path: string; operation: JournalEntrySummary['operation']; original: JournalOriginal; expected?: JournalOriginal | null; phase?: 'prepared' | 'applied'; resultingBytes: number };
export type JournalStorage = { put(name: string, bytes: Uint8Array): Promise<void>; get(name: string): Promise<Uint8Array | null>; remove(name: string): Promise<void>; list(): Promise<string[]>; clear(): Promise<void> };
type EncryptedRecord = { iv: Uint8Array; ciphertext: Uint8Array };
type DurableJournalStatus = 'allocated' | 'active' | 'finished';
type DurableJournalMetadata = {
  schemaVersion: 1;
  transactionId: string;
  status: DurableJournalStatus;
  outcome: 'committed' | 'rolled-back' | null;
  entryCount: number;
  entries: Array<{ id: number; phase: 'prepared' | 'applied'; sha256: string }>;
};

const encoder = new TextEncoder(); const decoder = new TextDecoder();
const asBase64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value));
const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const context = (transactionId: string, entryId: number): Uint8Array => encoder.encode(JSON.stringify({ transactionId, entryId, schemaVersion: 1 }));
const metadataContext = (transactionId: string): Uint8Array => encoder.encode(JSON.stringify({ transactionId, kind: 'journal-metadata', schemaVersion: 1 }));
const nameFor = (entryId: number): string => `entry-${entryId}.bin`;
const METADATA_NAME = 'journal-metadata.bin';

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
  private constructor(
    private readonly parent: FileSystemDirectoryHandle,
    private readonly transactionId: string,
    private readonly directory: FileSystemDirectoryHandle,
  ) {}
  private static async journalRoot(create: boolean): Promise<FileSystemDirectoryHandle> {
    const storage = (navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> }).getDirectory;
    if (!storage) throw new Error('JOURNAL_STORAGE_UNAVAILABLE');
    const root = await storage.call(navigator.storage);
    return root.getDirectoryHandle('kcode-journal', create ? { create: true } : undefined);
  }
  private static validId(value: string): boolean { return /^[A-Za-z0-9_-]{1,64}$/.test(value); }
  private static async workspaceRoot(workspaceId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!this.validId(workspaceId)) throw new Error('INVALID_WORKSPACE_BINDING');
    const journal = await this.journalRoot(create);
    return journal.getDirectoryHandle(workspaceId, create ? { create: true } : undefined);
  }
  static async open(workspaceId: string, transactionId: string): Promise<OpfsJournalStorage> {
    if (!this.validId(transactionId)) throw new Error('INVALID_TRANSACTION_ID');
    const journal = await this.workspaceRoot(workspaceId, true);
    return new OpfsJournalStorage(journal, transactionId, await journal.getDirectoryHandle(transactionId, { create: true }));
  }
  static async openExisting(workspaceId: string, transactionId: string): Promise<OpfsJournalStorage> {
    if (!this.validId(transactionId)) throw new Error('INVALID_TRANSACTION_ID');
    const journal = await this.workspaceRoot(workspaceId, false);
    return new OpfsJournalStorage(journal, transactionId, await journal.getDirectoryHandle(transactionId));
  }
  static async transactionIds(workspaceId: string): Promise<string[]> {
    try {
      const journal = await this.workspaceRoot(workspaceId, false); const ids: string[] = [];
      for await (const [name, handle] of (journal as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (handle.kind === 'directory' && this.validId(name)) ids.push(name);
      }
      return ids.sort();
    } catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return []; throw error; }
  }
  async put(name: string, bytes: Uint8Array): Promise<void> { const file = await this.directory.getFileHandle(name, { create: true }); const writable = await file.createWritable(); await writable.write(bytes as unknown as FileSystemWriteChunkType); await writable.close(); }
  async get(name: string): Promise<Uint8Array | null> { try { const file = await this.directory.getFileHandle(name); return new Uint8Array(await (await file.getFile()).arrayBuffer()); } catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return null; throw error; } }
  async remove(name: string): Promise<void> { await this.directory.removeEntry(name); }
  async list(): Promise<string[]> { const values: string[] = []; for await (const [name] of (this.directory as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) values.push(name); return values; }
  async clear(): Promise<void> {
    try {
      await this.parent.removeEntry(this.transactionId, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
  }
}

/** Encrypted, bounded rollback journal. OPFS adapters supply the durable storage in production. */
export class MutationJournal {
  private readonly entries: JournalEntrySummary[] = [];
  private readonly records: Array<{ id: number; record: JournalRecord; sha256: string }> = [];
  private state: JournalSummary['state'] = 'clean';
  private durableMetadata: DurableJournalMetadata | null = null;
  private journalBytes = 0;
  private writtenBytes = 0;
  private mutex: Promise<void> = Promise.resolve();
  private constructor(readonly transactionId: string, private readonly storage: JournalStorage, private readonly key: CryptoKey) {}

  static async begin(transactionId: string, storage: JournalStorage, key: CryptoKey | Promise<CryptoKey> = getJournalKey()): Promise<MutationJournal> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(transactionId)) throw new Error('INVALID_TRANSACTION_ID');
    if ((await storage.list()).length) throw new Error('JOURNAL_TRANSACTION_EXISTS');
    const journal = new MutationJournal(transactionId, storage, await key);
    await journal.persistMetadata('allocated', null, []);
    return journal;
  }
  /** Rehydrates a pre-existing transaction without ever treating its records as a new journal. */
  static async openExisting(transactionId: string, storage: JournalStorage, key: CryptoKey | Promise<CryptoKey> = getJournalKey()): Promise<MutationJournal> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(transactionId)) throw new Error('INVALID_TRANSACTION_ID');
    const journal = new MutationJournal(transactionId, storage, await key);
    const metadataBytes = await storage.get(METADATA_NAME);
    if (!metadataBytes) throw new Error('JOURNAL_TAMPERED');
    const metadata = await journal.decryptMetadata(metadataBytes);
    journal.validateMetadata(metadata);
    const names = await storage.list();
    const expectedNames = new Set([METADATA_NAME, ...metadata.entries.map(({ id }) => nameFor(id))]);
    if (names.length !== expectedNames.size || names.some((name) => !expectedNames.has(name))) throw new Error('JOURNAL_TAMPERED');
    for (const stateEntry of metadata.entries) {
      const encrypted = await storage.get(nameFor(stateEntry.id));
      if (!encrypted) throw new Error('JOURNAL_TAMPERED');
      if (await journal.hash(encrypted) !== stateEntry.sha256) throw new Error('JOURNAL_TAMPERED');
      const record = await journal.decrypt(stateEntry.id, encrypted);
      journal.validate(record);
      if (record.phase !== stateEntry.phase) throw new Error('JOURNAL_TAMPERED');
      const original = record.original.bytes ?? new Uint8Array();
      journal.records.push({ id: stateEntry.id, record, sha256: stateEntry.sha256 });
      journal.entries.push({ path: record.path, operation: record.operation, originalBytes: original.byteLength, resultingBytes: record.resultingBytes });
      journal.journalBytes += encrypted.byteLength; journal.writtenBytes += record.resultingBytes;
    }
    journal.durableMetadata = metadata;
    journal.state = 'needs-rollback';
    return journal;
  }
  summary(): JournalSummary { return { transactionId: this.transactionId, state: this.state, entries: [...this.entries], journalBytes: this.journalBytes, writtenBytes: this.writtenBytes }; }
  markNeedsRollback(): void { if (this.state === 'dirty') this.state = 'needs-rollback'; }

  async record(record: JournalRecord): Promise<void> { await this.serialized(() => this.recordUnlocked(record)); }
  private async recordUnlocked(record: JournalRecord): Promise<void> {
    if (this.state === 'needs-rollback' || this.state === 'conflict') throw new Error('JOURNAL_NOT_MUTABLE');
    if (this.records.some((entry) => entry.record.path === record.path)) return;
    const original = record.original.bytes ?? new Uint8Array();
    if (original.byteLength > MAX_JOURNAL_FILE_BYTES || record.resultingBytes > MAX_JOURNAL_FILE_BYTES) throw new Error('JOURNAL_FILE_LIMIT');
    if (this.writtenBytes + record.resultingBytes > MAX_JOURNAL_TRANSACTION_BYTES) throw new Error('JOURNAL_TRANSACTION_LIMIT');
    const id = this.records.length + 1;
    const normalized: JournalRecord = { ...record, phase: 'prepared', expected: null, original: { ...record.original, bytes: original } };
    const encrypted = await this.encrypt(id, normalized);
    if (this.journalBytes + encrypted.byteLength > MAX_JOURNAL_TRANSACTION_BYTES) throw new Error('JOURNAL_TRANSACTION_LIMIT');
    const stored = { id, record: normalized, sha256: await this.hash(encrypted) };
    await this.storage.put(nameFor(id), encrypted);
    await this.persistMetadata('active', null, [...this.records, stored]);
    this.records.push(stored);
    this.entries.push({ path: record.path, operation: record.operation, originalBytes: original.byteLength, resultingBytes: record.resultingBytes });
    this.journalBytes += encrypted.byteLength; this.writtenBytes += record.resultingBytes; this.state = 'dirty';
  }

  /** Persists the post-operation state after the FSA mutation completed. */
  async setExpected(path: string, expected: JournalOriginal): Promise<void> { await this.serialized(() => this.setExpectedUnlocked(path, expected)); }
  private async setExpectedUnlocked(path: string, expected: JournalOriginal): Promise<void> {
    const entry = this.records.find((candidate) => candidate.record.path === path);
    if (!entry || this.state === 'clean' || this.state === 'conflict') throw new Error('JOURNAL_EXPECTED_STATE_INVALID');
    const updatedRecord: JournalRecord = { ...entry.record, phase: 'applied', expected: { ...expected, bytes: undefined } };
    const encrypted = await this.encrypt(entry.id, updatedRecord);
    const updatedEntry = { id: entry.id, record: updatedRecord, sha256: await this.hash(encrypted) };
    const updatedRecords = this.records.map((candidate) => candidate.id === entry.id ? updatedEntry : candidate);
    await this.storage.put(nameFor(entry.id), encrypted);
    await this.persistMetadata('active', null, updatedRecords);
    entry.record = updatedRecord;
    entry.sha256 = updatedEntry.sha256;
  }

  async commit(): Promise<void> { await this.serialized(async () => { if (this.state === 'conflict') throw new Error('WORKSPACE_CONFLICT'); await this.readDurableRecords(); await this.persistMetadata('finished', 'committed', this.records); await this.storage.clear(); this.state = 'clean'; }); }
  async rollback(
    verifyOrRestore: ((path: string, expected: JournalOriginal) => Promise<boolean | void>) | ((path: string, original: JournalOriginal) => Promise<void>),
    maybeRestore?: (path: string, original: JournalOriginal) => Promise<void>,
  ): Promise<void> { await this.serialized(() => this.rollbackUnlocked(verifyOrRestore, maybeRestore)); }
  private async rollbackUnlocked(
    verifyOrRestore: ((path: string, expected: JournalOriginal) => Promise<boolean | void>) | ((path: string, original: JournalOriginal) => Promise<void>),
    maybeRestore?: (path: string, original: JournalOriginal) => Promise<void>,
  ): Promise<void> {
    if (this.state === 'conflict') throw new Error('WORKSPACE_CONFLICT');
    const verify = maybeRestore ? verifyOrRestore as (path: string, expected: JournalOriginal) => Promise<boolean | void> : async () => true;
    const restore = maybeRestore ?? verifyOrRestore as (path: string, original: JournalOriginal) => Promise<void>;
    const records = await this.readDurableRecords();
    for (const record of records) if (maybeRestore && (!record.expected || await verify(record.path, record.expected) === false)) { this.state = 'conflict'; throw new Error('WORKSPACE_CONFLICT'); }
    for (const record of records.reverse()) await restore(record.path, record.original);
    await this.persistMetadata('finished', 'rolled-back', this.records);
    await this.storage.clear(); this.state = 'clean';
  }

  /** Recovery for the preimage-to-poststate crash window. Ambiguous entries block attachment and remain durable. */
  async recoverConservatively(
    matchesOriginal: (path: string, original: JournalOriginal) => Promise<boolean>,
    restore: (path: string, original: JournalOriginal) => Promise<void>,
    matchesExpected?: (path: string, expected: JournalOriginal) => Promise<boolean>,
  ): Promise<'recovered'> {
    return this.serialized<'recovered'>(async () => {
      if (this.state === 'conflict') throw new Error('WORKSPACE_CONFLICT');
      const records = await this.readDurableRecords();
      if (this.durableMetadata?.status === 'allocated' || this.durableMetadata?.status === 'finished') {
        await this.storage.clear(); this.state = 'clean'; return 'recovered';
      }
      const pending = records.filter((record) => record.phase !== 'applied' || !record.expected);
      if (pending.length) {
        const originalsMatch = await Promise.all(pending.map((record) => matchesOriginal(record.path, record.original)));
        if (originalsMatch.some((matches) => !matches)) {
          this.state = 'conflict';
          throw new Error('WORKSPACE_CONFLICT');
        }
      }
      if (matchesExpected) for (const record of records) if (record.phase === 'applied' && record.expected && !(await matchesExpected(record.path, record.expected))) {
        this.state = 'conflict'; throw new Error('WORKSPACE_CONFLICT');
      }
      for (const record of records.reverse()) await restore(record.path, record.original);
      await this.persistMetadata('finished', 'rolled-back', this.records);
      await this.storage.clear(); this.state = 'clean';
      return 'recovered';
    });
  }

  private async encrypt(id: number, record: JournalRecord): Promise<Uint8Array> {
    const encode = (snapshot: JournalOriginal | null | undefined): Record<string, unknown> | null => snapshot ? { ...snapshot, bytes: asBase64(snapshot.bytes ?? new Uint8Array()) } : null;
    const plaintext = encoder.encode(JSON.stringify({ ...record, original: encode(record.original), expected: encode(record.expected) }));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: context(this.transactionId, id) as unknown as BufferSource }, this.key, plaintext));
    return encoder.encode(JSON.stringify({ iv: asBase64(iv), ciphertext: asBase64(ciphertext) }));
  }
  private async decrypt(id: number, bytes: Uint8Array): Promise<JournalRecord> {
    try {
      const parsed = JSON.parse(decoder.decode(bytes)) as { iv: string; ciphertext: string };
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(parsed.iv) as unknown as BufferSource, additionalData: context(this.transactionId, id) as unknown as BufferSource }, this.key, fromBase64(parsed.ciphertext) as unknown as BufferSource);
      const parsedRecord = JSON.parse(decoder.decode(plaintext)) as JournalRecord & { original: Omit<JournalOriginal, 'bytes'> & { bytes: string }; expected?: (Omit<JournalOriginal, 'bytes'> & { bytes: string }) | null };
      const decode = (snapshot: (Omit<JournalOriginal, 'bytes'> & { bytes: string }) | null | undefined): JournalOriginal | null => snapshot ? { ...snapshot, bytes: fromBase64(snapshot.bytes) } : null;
      return { ...parsedRecord, original: decode(parsedRecord.original)!, expected: decode(parsedRecord.expected) };
    } catch { this.state = 'conflict'; throw new Error('JOURNAL_TAMPERED'); }
  }
  private async persistMetadata(status: DurableJournalStatus, outcome: DurableJournalMetadata['outcome'], records: typeof this.records): Promise<void> {
    const metadata: DurableJournalMetadata = {
      schemaVersion: 1,
      transactionId: this.transactionId,
      status,
      outcome,
      entryCount: records.length,
      entries: records.map(({ id, record, sha256 }) => ({ id, phase: record.phase ?? 'prepared', sha256 })),
    };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: metadataContext(this.transactionId) as unknown as BufferSource },
      this.key,
      encoder.encode(JSON.stringify(metadata)),
    ));
    await this.storage.put(METADATA_NAME, encoder.encode(JSON.stringify({ iv: asBase64(iv), ciphertext: asBase64(ciphertext) })));
    this.durableMetadata = metadata;
  }
  private async decryptMetadata(bytes: Uint8Array): Promise<DurableJournalMetadata> {
    try {
      const parsed = JSON.parse(decoder.decode(bytes)) as { iv: string; ciphertext: string };
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(parsed.iv) as unknown as BufferSource, additionalData: metadataContext(this.transactionId) as unknown as BufferSource },
        this.key,
        fromBase64(parsed.ciphertext) as unknown as BufferSource,
      );
      return JSON.parse(decoder.decode(plaintext)) as DurableJournalMetadata;
    } catch { this.state = 'conflict'; throw new Error('JOURNAL_TAMPERED'); }
  }
  private validateMetadata(metadata: DurableJournalMetadata): void {
    if (!metadata || metadata.schemaVersion !== 1 || metadata.transactionId !== this.transactionId
      || !['allocated', 'active', 'finished'].includes(metadata.status)
      || !Number.isSafeInteger(metadata.entryCount) || metadata.entryCount < 0
      || !Array.isArray(metadata.entries) || metadata.entries.length !== metadata.entryCount
      || metadata.entries.some((entry, index) => entry?.id !== index + 1
        || (entry.phase !== 'prepared' && entry.phase !== 'applied')
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256))
      || (metadata.status === 'allocated' && (metadata.entryCount !== 0 || metadata.outcome !== null))
      || (metadata.status === 'active' && (metadata.entryCount === 0 || metadata.outcome !== null))
      || (metadata.status === 'finished' && metadata.outcome !== 'committed' && metadata.outcome !== 'rolled-back')) throw new Error('JOURNAL_TAMPERED');
  }
  private async readDurableRecords(): Promise<JournalRecord[]> {
    const metadataBytes = await this.storage.get(METADATA_NAME);
    if (!metadataBytes) throw new Error('JOURNAL_TAMPERED');
    const metadata = await this.decryptMetadata(metadataBytes);
    this.validateMetadata(metadata);
    if (!this.sameMetadata(metadata, this.durableMetadata)) throw new Error('JOURNAL_TAMPERED');
    const names = await this.storage.list();
    const expectedNames = new Set([METADATA_NAME, ...metadata.entries.map(({ id }) => nameFor(id))]);
    if (names.length !== expectedNames.size || names.some((name) => !expectedNames.has(name))) throw new Error('JOURNAL_TAMPERED');
    const records: JournalRecord[] = [];
    for (const stateEntry of metadata.entries) {
      const encrypted = await this.storage.get(nameFor(stateEntry.id));
      if (!encrypted || await this.hash(encrypted) !== stateEntry.sha256) throw new Error('JOURNAL_TAMPERED');
      const record = await this.decrypt(stateEntry.id, encrypted);
      this.validate(record);
      if (record.phase !== stateEntry.phase) throw new Error('JOURNAL_TAMPERED');
      records.push(record);
    }
    return records;
  }
  private sameMetadata(left: DurableJournalMetadata, right: DurableJournalMetadata | null): boolean {
    return right !== null && JSON.stringify(left) === JSON.stringify(right);
  }
  private async hash(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  private validate(record: JournalRecord): void {
    if (!record || typeof record.path !== 'string' || record.path.split('/').some((part) => !part || part === '.' || part === '..')
      || !['create', 'write', 'delete', 'rename'].includes(record.operation)
      || !Number.isSafeInteger(record.resultingBytes) || record.resultingBytes < 0 || record.resultingBytes > MAX_JOURNAL_FILE_BYTES
      || !record.original || typeof record.original.exists !== 'boolean'
      || (record.phase !== undefined && record.phase !== 'prepared' && record.phase !== 'applied')
      || (record.expected !== null && record.expected !== undefined && typeof record.expected.exists !== 'boolean')) throw new Error('JOURNAL_TAMPERED');
  }
  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
