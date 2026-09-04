import { describe, expect, it } from 'vitest';
import { MutationJournal, MemoryJournalStorage } from '../../../src/worker/p9/mutation-journal';

describe('MutationJournal', () => {
  it('encrypts the original file before mutation and restores it on rollback', async () => {
    // Break caught: a plaintext/no-backup mutation makes rollback either disclose source bytes or lose them after a failed tool action.
    const storage = new MemoryJournalStorage();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const journal = await MutationJournal.begin('txn-1', storage, key);
    const original = new TextEncoder().encode('before');
    await journal.record({ path: 'notes.txt', operation: 'write', original: { exists: true, bytes: original, lastModified: 1 }, resultingBytes: 5 });
    expect(storage.bytes().some((value) => new TextDecoder().decode(value).includes('before'))).toBe(false);
    const restored: Array<{ path: string; bytes: Uint8Array | null }> = [];
    await journal.rollback(async (path, originalFile) => { restored.push({ path, bytes: originalFile?.bytes ?? null }); });
    expect(restored).toEqual([{ path: 'notes.txt', bytes: original }]);
  });

  it('preserves both versions when the current workspace no longer matches the expected post-mutation state', async () => {
    // Break caught: restoring an old preimage over an external edit destroys the user’s newer host change.
    const storage = new MemoryJournalStorage();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const journal = await MutationJournal.begin('txn-conflict', storage, key);
    await journal.record({ path: 'notes.txt', operation: 'write', original: { exists: true, bytes: new TextEncoder().encode('before'), size: 6 }, resultingBytes: 7 });
    await journal.setExpected('notes.txt', { exists: true, size: 7, lastModified: 2, sha256: 'expected' });
    const restored: string[] = [];

    await expect(journal.rollback(async () => false, async (path) => { restored.push(path); })).rejects.toThrow('WORKSPACE_CONFLICT');
    expect(restored).toEqual([]);
    expect(await storage.list()).not.toEqual([]);
  });

  it('reopens and validates an unfinished encrypted transaction before recovery', async () => {
    // Break caught: a browser restart otherwise loses the in-memory preimage and lets a transaction ID be reused over unrecovered host changes.
    const storage = new MemoryJournalStorage();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const initial = await MutationJournal.begin('txn-recover', storage, key);
    await initial.record({ path: 'recover.txt', operation: 'create', original: { exists: false }, resultingBytes: 3 });
    await initial.setExpected('recover.txt', { exists: true, kind: 'file', size: 3, lastModified: 2, sha256: 'abc' });

    const recovered = await MutationJournal.openExisting('txn-recover', storage, key);
    const restored: string[] = [];
    await recovered.rollback(async (_path, expected) => expected.sha256 === 'abc', async (path) => { restored.push(path); });
    expect(restored).toEqual(['recover.txt']);
    await expect(MutationJournal.begin('txn-recover', storage, key)).resolves.toBeInstanceOf(MutationJournal);
  });

  it('allocates unique durable entry IDs when mutations record concurrently', async () => {
    // Break caught: concurrent first writes can both select entry-1 and overwrite one another’s only rollback preimage.
    const storage = new MemoryJournalStorage();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const journal = await MutationJournal.begin('txn-concurrent', storage, key);
    await Promise.all([
      journal.record({ path: 'one.txt', operation: 'create', original: { exists: false }, resultingBytes: 1 }),
      journal.record({ path: 'two.txt', operation: 'create', original: { exists: false }, resultingBytes: 1 }),
    ]);
    expect(await storage.list()).toEqual(['entry-1.bin', 'entry-2.bin']);
  });

  it('abandons a preimage-only crash record when the workspace no longer matches its original state', async () => {
    // Break caught: crashing after the durable preimage but before expected-state capture must not make every later attach fail forever.
    const storage = new MemoryJournalStorage();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const initial = await MutationJournal.begin('txn-pending', storage, key);
    await initial.record({ path: 'created.txt', operation: 'create', original: { exists: false }, resultingBytes: 4 });

    const recovered = await MutationJournal.openExisting('txn-pending', storage, key);
    await expect(recovered.recoverConservatively(async () => false, async () => undefined)).resolves.toBe('abandoned');
    expect(await storage.list()).toEqual([]);
  });
});
