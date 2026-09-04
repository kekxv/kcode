import { describe, expect, it } from 'vitest';
import { MemoryFsaRoot } from '../../helpers/memory-fsa';
import { FsaBackend, P9Error } from '../../../src/worker/p9/fsa-backend';

describe('FsaBackend capability confinement', () => {
  it('walks from the authorized root only after exact resolve and denies default mutations', async () => {
    // Break caught: trusting a descendant handle without root.resolve permits a swapped handle escape; allowing mutations under read-only leaks host write authority.
    const root = new MemoryFsaRoot();
    const src = await root.getDirectoryHandle('src', { create: true });
    const file = await src.getFileHandle('readme.txt', { create: true });
    const writable = await file.createWritable(); await writable.write(new TextEncoder().encode('safe')); await writable.close();
    const backend = await FsaBackend.attach(root as unknown as FileSystemDirectoryHandle, ['read']);

    expect(new TextDecoder().decode(await backend.read(['src', 'readme.txt'], 0, 32))).toBe('safe');
    await expect(backend.createFile([], 'new.txt')).rejects.toMatchObject({ errno: 13 } satisfies Partial<P9Error>);
    expect(root.resolveCalls.length).toBeGreaterThan(0);
  });
});
