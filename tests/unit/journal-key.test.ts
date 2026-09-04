import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJournalKey } from '../../src/security/journal-key';

afterEach(() => vi.unstubAllGlobals());

describe('journal key', () => {
  it('persists a non-extractable AES-GCM key without exposing raw key material', async () => {
    // Break caught: an extractable journal key allows any extension-context bug to decrypt rollback data.
    vi.stubGlobal('indexedDB', indexedDB);
    const first = await getJournalKey(); const second = await getJournalKey();
    expect(first.extractable).toBe(false);
    expect(first.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(second).toMatchObject({ type: 'secret', extractable: false, usages: ['encrypt', 'decrypt'] });
    await expect(crypto.subtle.exportKey('raw', first)).rejects.toThrow();
  });
});
