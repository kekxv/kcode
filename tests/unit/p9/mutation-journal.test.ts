import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsaBackend } from '../../../src/worker/p9/fsa-backend';
import { MutationJournal, MemoryJournalStorage, OpfsJournalStorage } from '../../../src/worker/p9/mutation-journal';
import { MemoryFsaRoot } from '../../helpers/memory-fsa';

afterEach(() => vi.unstubAllGlobals());

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
    expect((await storage.list()).filter((name) => name.startsWith('entry-'))).toEqual(['entry-1.bin', 'entry-2.bin']);
  });

  it('retains the journal and blocks recovery after FSA apply crashes before post-state persistence', async () => {
    // Break caught: the exact apply-to-setExpected crash window must not silently clear the only record of an uncommitted durable host mutation.
    const storage = new MemoryJournalStorage();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const root = new MemoryFsaRoot();
    const file = await root.getFileHandle('notes.txt', { create: true });
    const writable = await file.createWritable(); await writable.write(new TextEncoder().encode('before')); await writable.close();
    const backend = await FsaBackend.attach(root as unknown as FileSystemDirectoryHandle, ['read', 'write']);
    const original = await backend.snapshot(['notes.txt']);
    const initial = await MutationJournal.begin('txn-pending', storage, key);
    await initial.record({ path: 'notes.txt', operation: 'write', original, resultingBytes: 6 });

    // This is the crash point: FSA has durably changed, but setExpected was never reached.
    await backend.write(['notes.txt'], 0, new TextEncoder().encode('after!'));

    const recovered = await MutationJournal.openExisting('txn-pending', storage, key);
    await expect(recovered.recoverConservatively(
      async (path, snapshot) => backend.matchesSnapshot(path.split('/'), snapshot),
      async (path, snapshot) => backend.restore(path.split('/'), snapshot),
    )).rejects.toThrow('WORKSPACE_CONFLICT');
    const current = await (await root.getFileHandle('notes.txt')).getFile();
    expect(new TextDecoder().decode(new Uint8Array(await current.arrayBuffer()))).toBe('after!');
    expect(await storage.list()).toContain('entry-1.bin');
  });

  it('rejects tampering with authenticated journal metadata', async () => {
    // Break caught: unauthenticated allocation metadata lets an attacker forge the only state recovery is allowed to clean without records.
    const storage = new MemoryJournalStorage();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await MutationJournal.begin('txn-metadata-tamper', storage, key);

    await storage.put('journal-metadata.bin', new Uint8Array([1]));

    await expect(MutationJournal.openExisting('txn-metadata-tamper', storage, key)).rejects.toThrow('JOURNAL_TAMPERED');
  });

  it('rejects a deleted entry after commit has durably reached finished state', async () => {
    // Break caught: failed directory cleanup must not let a finished marker hide deletion of the rollback record it authenticates.
    class InterruptedClearStorage extends MemoryJournalStorage {
      override async clear(): Promise<void> { throw new Error('CLEAR_INTERRUPTED'); }
    }
    const storage = new InterruptedClearStorage();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const journal = await MutationJournal.begin('txn-finished-tamper', storage, key);
    await journal.record({ path: 'changed.txt', operation: 'create', original: { exists: false }, resultingBytes: 1 });
    await journal.setExpected('changed.txt', { exists: true, kind: 'file', size: 1, lastModified: 1, sha256: 'finished' });
    await expect(journal.commit()).rejects.toThrow('CLEAR_INTERRUPTED');

    await storage.remove('entry-1.bin');

    await expect(MutationJournal.openExisting('txn-finished-tamper', storage, key)).rejects.toThrow('JOURNAL_TAMPERED');
  });

  it('removes the committed OPFS transaction directory from recovery enumeration', async () => {
    // Break caught: deleting only record files leaves an empty transaction directory that the next startup treats as a tampered journal.
    const opfsRoot = new MemoryFsaRoot();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfsRoot } });
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const journal = await MutationJournal.begin('txn-committed', await OpfsJournalStorage.open('workspace-1', 'txn-committed'), key);
    await journal.record({ path: 'created.txt', operation: 'create', original: { exists: false }, resultingBytes: 1 });

    await journal.commit();

    await expect(OpfsJournalStorage.transactionIds('workspace-1')).resolves.toEqual([]);
    await expect(MutationJournal.begin(
      'txn-committed',
      await OpfsJournalStorage.open('workspace-1', 'txn-committed'),
      key,
    )).resolves.toBeInstanceOf(MutationJournal);
  });
});
