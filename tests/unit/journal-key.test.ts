import { indexedDB } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJournalKey } from '../../src/security/journal-key';

afterEach(() => vi.unstubAllGlobals());

const deleteDatabase = (): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase('kcode');
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error);
});

beforeEach(async () => {
  await deleteDatabase();
  vi.stubGlobal('indexedDB', indexedDB);
});

describe('journal key', () => {
  it('persists a non-extractable AES-GCM key without exposing raw key material', async () => {
    // Break caught: an extractable journal key allows any extension-context bug to decrypt rollback data.
    const first = await getJournalKey(); const second = await getJournalKey();
    expect(first.extractable).toBe(false);
    expect(first.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(second).toMatchObject({ type: 'secret', extractable: false, usages: ['encrypt', 'decrypt'] });
    await expect(crypto.subtle.exportKey('raw', first)).rejects.toThrow();
  });

  it('upgrades an existing origin database that predates the journal-key store', async () => {
    // Break caught: opening `kcode` at a fixed legacy version leaves a real extension database without security-keys and turns approved guest writes into EIO.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('kcode', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('legacy');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    await expect(getJournalKey()).resolves.toMatchObject({ type: 'secret', extractable: false });
  });

  it('returns one persisted non-extractable key to twenty concurrent callers', async () => {
    // Break caught: racing Workers can each return a different generated key even though the final IndexedDB put keeps only the last one.
    const keys = await Promise.all(Array.from({ length: 20 }, () => getJournalKey()));
    const persisted = await getJournalKey();
    const plaintext = new TextEncoder().encode('shared-journal-key');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys[0], plaintext);

    expect(keys).toHaveLength(20);
    expect(keys.every((key) => key.extractable === false)).toBe(true);
    for (const key of [...keys, persisted]) {
      await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext))
        .resolves.toEqual(plaintext.buffer);
    }
  });
});
