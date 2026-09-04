import { describe, expect, it, vi } from 'vitest';
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

  it('enforces read capability for metadata traversal as well as file bytes', async () => {
    // Break caught: getattr/walk can expose protected workspace names and sizes even when read is denied.
    const root = new MemoryFsaRoot();
    await root.getFileHandle('visible.txt', { create: true });
    const backend = await FsaBackend.attach(root as unknown as FileSystemDirectoryHandle, []);
    await expect(backend.stat(['visible.txt'])).rejects.toMatchObject({ errno: 13 });
  });

  it('holds a timed-out mutation lock until the underlying FSA operation settles', async () => {
    // Break caught: Promise.race can report ETIMEDOUT while createWritable still mutates, so releasing this lock permits a concurrent conflicting write.
    vi.useFakeTimers();
    try {
      const root = new MemoryFsaRoot();
      const original = root.getFileHandle.bind(root);
      let releaseFirstWrite: (() => void) | undefined;
      let writableCalls = 0;
      await original('slow.txt', { create: true });
      root.getFileHandle = async (name, options) => {
        const handle = await original(name, options);
        if (name !== 'slow.txt') return handle;
        const delayed = Object.create(handle) as FileSystemFileHandle;
        delayed.createWritable = async (writeOptions) => {
          writableCalls += 1;
          if (writableCalls === 1) await new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
          return handle.createWritable(writeOptions);
        };
        return delayed;
      };
      const backend = await FsaBackend.attach(root as unknown as FileSystemDirectoryHandle, ['read', 'write']);

      const first = backend.write(['slow.txt'], 0, new TextEncoder().encode('first'));
      const firstError = first.then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(writableCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await firstError).toMatchObject({ errno: 110 });

      const second = backend.write(['slow.txt'], 0, new TextEncoder().encode('second'));
      await vi.advanceTimersByTimeAsync(0);
      expect(writableCalls).toBe(1);
      releaseFirstWrite?.();
      await expect(second).resolves.toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
