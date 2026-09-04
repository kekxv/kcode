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

const sameEntryDirectoryHandle = (entryId: string): FileSystemDirectoryHandle => {
  const handle = { kind: 'directory', name: entryId, entryId } as unknown as FileSystemDirectoryHandle & { entryId: string };
  Object.defineProperty(handle, 'isSameEntry', {
    value: vi.fn(async (other: FileSystemHandle) => (other as unknown as { entryId?: string }).entryId === entryId),
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

  it('loads the persisted workspace after another component upgrades the shared database', async () => {
    // Break caught: reopening the shared kcode database at a stale fixed version makes every later Worker binding check fail closed.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kcode', 2);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('workspace', 'readwrite');
      transaction.objectStore('workspace').put({ workspaceId: 'persisted-id', handle: { kind: 'directory' } }, 'selected-directory');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    await expect(new WorkspaceStore().load()).resolves.toEqual({ workspaceId: 'persisted-id', handle: { kind: 'directory' } });
  });

  it('queries read permission without escalating', async () => {
    const store = new WorkspaceStore();
    const handle = directoryHandle();
    await store.save(handle as unknown as FileSystemDirectoryHandle);

    await expect(store.getPermission()).resolves.toBe('prompt');
    expect(handle.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('rejects write permission requests without an active user gesture', async () => {
    vi.stubGlobal('navigator', { userActivation: { isActive: false } });
    const store = new WorkspaceStore();
    const handle = directoryHandle();
    await store.save(handle as unknown as FileSystemDirectoryHandle);

    await expect(store.requestReadWrite()).rejects.toThrow('USER_ACTIVATION_REQUIRED');
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('requests readwrite permission while a user gesture is active', async () => {
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    const store = new WorkspaceStore();
    const handle = directoryHandle();
    await store.save(handle as unknown as FileSystemDirectoryHandle);

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

  it('binds a workspace id to the browser-authenticated directory entry rather than object identity', async () => {
    // Break caught: accepting workspaceId alone lets a different attached handle consume the selected directory's recovery journal.
    const store = new WorkspaceStore();
    const selected = sameEntryDirectoryHandle('selected-entry');
    const saved = await store.save(selected);

    await expect(store.verifyHandleBinding(saved.workspaceId, sameEntryDirectoryHandle('selected-entry'))).resolves.toBeUndefined();
    await expect(store.verifyHandleBinding(saved.workspaceId, sameEntryDirectoryHandle('wrong-entry'))).rejects.toThrow('WORKSPACE_HANDLE_MISMATCH');
    await expect(store.verifyHandleBinding('forged-workspace-id', sameEntryDirectoryHandle('selected-entry'))).rejects.toThrow('WORKSPACE_HANDLE_MISMATCH');
  });

  it('rejects a cached binding after another store replaces the persisted selection', async () => {
    // Break caught: a long-lived Worker cache can authorize an old handle after another Side Panel context selects a new workspace.
    const workerStore = new WorkspaceStore();
    const first = await workerStore.save(sameEntryDirectoryHandle('first-entry'));
    await workerStore.load();
    await new WorkspaceStore().save(sameEntryDirectoryHandle('replacement-entry'));

    await expect(workerStore.verifyHandleBinding(first.workspaceId, sameEntryDirectoryHandle('first-entry')))
      .rejects.toThrow('WORKSPACE_HANDLE_MISMATCH');
  });

  it('maps a cancelled directory selection to a stable code', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')));

    await expect(new WorkspaceStore().selectDirectory()).rejects.toThrow('DIRECTORY_PICKER_ABORTED');
  });
});
