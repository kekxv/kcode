export type StoredWorkspace = {
  workspaceId: string;
  handle: FileSystemDirectoryHandle;
};

const DATABASE_NAME = 'kcode';
const DATABASE_VERSION = 1;
const WORKSPACE_STORE = 'workspace';
const SELECTED_DIRECTORY_KEY = 'selected-directory';

type StableErrorCode =
  | 'DIRECTORY_PICKER_ABORTED'
  | 'DIRECTORY_PERMISSION_DENIED'
  | 'INDEXEDDB_UNAVAILABLE'
  | 'WORKSPACE_NOT_SELECTED'
  | 'WORKSPACE_STORAGE_FAILURE';

type DirectoryPermissionOptions = { mode: 'read' | 'readwrite' };
type PermissionedDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options: DirectoryPermissionOptions): Promise<PermissionState>;
  requestPermission(options: DirectoryPermissionOptions): Promise<PermissionState>;
};
type DirectoryPicker = (options: { mode: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

const stableError = (code: StableErrorCode): Error => new Error(code);

const mapError = (error: unknown, operation: 'picker' | 'storage'): Error => {
  if (error instanceof DOMException) {
    if (error.name === 'AbortError' && operation === 'picker') return stableError('DIRECTORY_PICKER_ABORTED');
    if (error.name === 'NotAllowedError') return stableError('DIRECTORY_PERMISSION_DENIED');
  }
  return stableError('WORKSPACE_STORAGE_FAILURE');
};

const databaseFactory = (): IDBFactory => {
  if (typeof indexedDB === 'undefined') throw stableError('INDEXEDDB_UNAVAILABLE');
  return indexedDB;
};

const directoryPicker = (): DirectoryPicker | undefined =>
  (globalThis as typeof globalThis & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

const openDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  let request: IDBOpenDBRequest;
  try {
    request = databaseFactory().open(DATABASE_NAME, DATABASE_VERSION);
  } catch (error) {
    reject(error instanceof Error ? error : stableError('WORKSPACE_STORAGE_FAILURE'));
    return;
  }
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(WORKSPACE_STORE)) {
      request.result.createObjectStore(WORKSPACE_STORE);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(mapError(request.error, 'storage'));
  request.onblocked = () => reject(stableError('WORKSPACE_STORAGE_FAILURE'));
});

const isStoredWorkspace = (value: unknown): value is StoredWorkspace => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && typeof record.workspaceId === 'string'
    && record.workspaceId.length > 0
    && typeof record.handle === 'object'
    && record.handle !== null;
};

export class WorkspaceStore {
  private cachedWorkspace: StoredWorkspace | undefined;

  private async transact<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await openDatabase();
    try {
      return await new Promise<T>((resolve, reject) => {
        let request: IDBRequest<T>;
        let result: T;
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(WORKSPACE_STORE, mode);
          request = operation(transaction.objectStore(WORKSPACE_STORE));
        } catch (error) {
          reject(mapError(error, 'storage'));
          return;
        }
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(mapError(request.error, 'storage'));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(mapError(transaction.error, 'storage'));
        transaction.onabort = () => reject(mapError(transaction.error, 'storage'));
      });
    } finally {
      database.close();
    }
  }

  async save(handle: FileSystemDirectoryHandle): Promise<StoredWorkspace> {
    const workspace: StoredWorkspace = { workspaceId: crypto.randomUUID(), handle };
    await this.transact('readwrite', (store) => store.put(workspace, SELECTED_DIRECTORY_KEY));
    this.cachedWorkspace = workspace;
    return workspace;
  }

  async load(): Promise<StoredWorkspace | null> {
    if (this.cachedWorkspace !== undefined) return this.cachedWorkspace;
    const workspace = await this.transact('readonly', (store) => store.get(SELECTED_DIRECTORY_KEY));
    if (workspace === undefined) return null;
    if (!isStoredWorkspace(workspace)) throw stableError('WORKSPACE_STORAGE_FAILURE');
    this.cachedWorkspace = workspace;
    return workspace;
  }

  async selectDirectory(): Promise<StoredWorkspace> {
    const picker = directoryPicker();
    if (picker === undefined) throw stableError('INDEXEDDB_UNAVAILABLE');
    try {
      const handle = await picker({ mode: 'read' });
      return await this.save(handle);
    } catch (error) {
      throw mapError(error, 'picker');
    }
  }

  async getPermission(): Promise<PermissionState> {
    const workspace = await this.load();
    if (workspace === null) throw stableError('WORKSPACE_NOT_SELECTED');
    try {
      return await (workspace.handle as PermissionedDirectoryHandle).queryPermission({ mode: 'read' });
    } catch (error) {
      throw mapError(error, 'storage');
    }
  }

  async requestReadWrite(): Promise<PermissionState> {
    const workspace = await this.load();
    if (workspace === null) throw stableError('WORKSPACE_NOT_SELECTED');
    try {
      return await (workspace.handle as PermissionedDirectoryHandle).requestPermission({ mode: 'readwrite' });
    } catch (error) {
      throw mapError(error, 'storage');
    }
  }

  async clear(): Promise<void> {
    await this.transact('readwrite', (store) => store.delete(SELECTED_DIRECTORY_KEY));
    this.cachedWorkspace = undefined;
  }
}
