import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../../src/utils/idb-store';

type DirectoryHandle = {
  queryPermission: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
};

const directoryHandle = (): DirectoryHandle => {
  const handle = {} as DirectoryHandle;
  Object.defineProperties(handle, {
    queryPermission: { value: vi.fn().mockResolvedValue('prompt') },
    requestPermission: { value: vi.fn().mockResolvedValue('granted') },
  });
  return handle;
};

const deleteDatabase = (): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase('kcode');
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('database remained open'));
});

afterEach(async () => {
  await deleteDatabase();
  vi.unstubAllGlobals();
});

describe('WorkspaceStore', () => {
  it('round-trips a directory handle without requesting permission on startup', async () => {
    const store = new WorkspaceStore();
    const handle = directoryHandle();

    const saved = await store.save(handle as unknown as FileSystemDirectoryHandle);

    expect(saved).toEqual({ workspaceId: expect.any(String), handle });
    expect(await store.load()).toEqual(saved);
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('queries read permission without escalating and requests readwrite only explicitly', async () => {
    const store = new WorkspaceStore();
    const handle = directoryHandle();
    await store.save(handle as unknown as FileSystemDirectoryHandle);

    await expect(store.getPermission()).resolves.toBe('prompt');
    expect(handle.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(handle.requestPermission).not.toHaveBeenCalled();

    await expect(store.requestReadWrite()).resolves.toBe('granted');
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  it('replaces the opaque workspace identity and clears the selected directory', async () => {
    const store = new WorkspaceStore();
    const first = await store.save(directoryHandle() as unknown as FileSystemDirectoryHandle);
    const second = await store.save(directoryHandle() as unknown as FileSystemDirectoryHandle);

    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect((await store.load())?.handle).toBe(second.handle);
    await store.clear();
    await expect(store.load()).resolves.toBeNull();
  });

  it('maps a cancelled directory selection to a stable code', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')));

    await expect(new WorkspaceStore().selectDirectory()).rejects.toThrow('DIRECTORY_PICKER_ABORTED');
  });
});
