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
});
