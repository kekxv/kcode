const DATABASE = 'kcode';
const STORE = 'security-keys';
const KEY = 'mutation-journal-aes-gcm-256';

const openDatabase = (version?: number): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = version === undefined ? indexedDB.open(DATABASE) : indexedDB.open(DATABASE, version);
  request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('JOURNAL_KEY_STORE_FAILED'));
});
const openKeyDatabase = async (): Promise<IDBDatabase> => {
  let database = await openDatabase();
  if (database.objectStoreNames.contains(STORE)) return database;
  const nextVersion = database.version + 1;
  database.close();
  database = await openDatabase(nextVersion);
  if (database.objectStoreNames.contains(STORE)) return database;
  database.close();
  throw new Error('JOURNAL_KEY_STORE_FAILED');
};
const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('JOURNAL_KEY_STORE_FAILED')); });
const isJournalKey = (value: unknown): value is CryptoKey => {
  if (!value || typeof value !== 'object') return false;
  const key = value as CryptoKey;
  return key.type === 'secret'
    && key.extractable === false
    && key.algorithm?.name === 'AES-GCM'
    && (key.algorithm as AesKeyAlgorithm).length === 256
    && key.usages.includes('encrypt')
    && key.usages.includes('decrypt');
};
const readKey = async (database: IDBDatabase): Promise<unknown> => {
  const transaction = database.transaction(STORE, 'readonly');
  return requestResult(transaction.objectStore(STORE).get(KEY));
};
const addKey = (database: IDBDatabase, key: CryptoKey): Promise<void> => new Promise((resolve, reject) => {
  const transaction = database.transaction(STORE, 'readwrite');
  const request = transaction.objectStore(STORE).add(key, KEY);
  let collided = false;
  request.onerror = (event) => {
    if (request.error?.name === 'ConstraintError') {
      collided = true;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    reject(request.error ?? new Error('JOURNAL_KEY_STORE_FAILED'));
  };
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => { if (!collided) reject(transaction.error ?? new Error('JOURNAL_KEY_STORE_FAILED')); };
  transaction.onabort = () => reject(transaction.error ?? new Error('JOURNAL_KEY_STORE_FAILED'));
});

/** Returns the origin-local structured-cloneable journal key; it is deliberately non-extractable. */
export const getJournalKey = async (): Promise<CryptoKey> => {
  if (typeof indexedDB === 'undefined') throw new Error('JOURNAL_KEY_STORE_UNAVAILABLE');
  const database = await openKeyDatabase();
  try {
    const saved = await readKey(database);
    if (saved !== undefined) {
      if (!isJournalKey(saved)) throw new Error('JOURNAL_KEY_STORE_FAILED');
      return saved;
    }
    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    // Readwrite transactions are serialized across same-origin Worker
    // connections. `add` elects one winner; a constraint collision leaves the
    // winner untouched, after which every contender reads that persisted key.
    await addKey(database, candidate);
    const persisted = await readKey(database);
    if (!isJournalKey(persisted)) throw new Error('JOURNAL_KEY_STORE_FAILED');
    return persisted;
  } finally { database.close(); }
};
