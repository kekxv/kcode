import type { MemoryProfile } from '../types/protocol';

const DATABASE_NAME = 'kcode-vm-snapshots';
const STORE_NAME = 'snapshots';
const FORMAT = 'v86-d96be77-kcode-boot-assets-1';
const MAX_SNAPSHOT_BYTES = 768 * 1024 * 1024;

type SnapshotRecord = {
  format: string;
  memoryProfile: MemoryProfile;
  state: ArrayBuffer;
};

const keyFor = (memoryProfile: MemoryProfile): string => `${FORMAT}:${memoryProfile}`;

const openDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') { reject(new Error('INDEXEDDB_UNAVAILABLE')); return; }
  const request = indexedDB.open(DATABASE_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('VM_SNAPSHOT_STORAGE_FAILED'));
  request.onblocked = () => reject(new Error('VM_SNAPSHOT_STORAGE_FAILED'));
});

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('VM_SNAPSHOT_STORAGE_FAILED'));
});

const isSnapshotRecord = (value: unknown, memoryProfile: MemoryProfile): value is SnapshotRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<SnapshotRecord>;
  return record.format === FORMAT
    && record.memoryProfile === memoryProfile
    && record.state instanceof ArrayBuffer
    && record.state.byteLength > 0
    && record.state.byteLength <= MAX_SNAPSHOT_BYTES;
};

/** Browser-local boot states. They are never packaged, synced, or sent to a relay. */
export class UserVmSnapshotStore {
  async load(memoryProfile: MemoryProfile): Promise<ArrayBuffer | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const record = await requestResult(transaction.objectStore(STORE_NAME).get(keyFor(memoryProfile)));
      return isSnapshotRecord(record, memoryProfile) ? record.state : null;
    } finally {
      database.close();
    }
  }

  async save(memoryProfile: MemoryProfile, state: ArrayBuffer): Promise<void> {
    if (state.byteLength === 0 || state.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('VM_SNAPSHOT_INVALID');
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      await requestResult(transaction.objectStore(STORE_NAME).put({ format: FORMAT, memoryProfile, state }, keyFor(memoryProfile)));
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('VM_SNAPSHOT_STORAGE_FAILED'));
        transaction.onabort = () => reject(transaction.error ?? new Error('VM_SNAPSHOT_STORAGE_FAILED'));
      });
    } finally {
      database.close();
    }
  }
}
