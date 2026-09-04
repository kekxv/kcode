const DATABASE = 'kcode';
const STORE = 'security-keys';
const KEY = 'mutation-journal-aes-gcm-256';

const openDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('JOURNAL_KEY_STORE_FAILED'));
});
const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('JOURNAL_KEY_STORE_FAILED')); });

/** Returns the origin-local structured-cloneable journal key; it is deliberately non-extractable. */
export const getJournalKey = async (): Promise<CryptoKey> => {
  if (typeof indexedDB === 'undefined') throw new Error('JOURNAL_KEY_STORE_UNAVAILABLE');
  const database = await openDatabase();
  try {
    const readTransaction = database.transaction(STORE, 'readonly');
    const saved = await requestResult(readTransaction.objectStore(STORE).get(KEY));
    if (saved && typeof saved === 'object' && (saved as CryptoKey).type === 'secret' && (saved as CryptoKey).algorithm.name === 'AES-GCM' && (saved as CryptoKey).extractable === false) return saved as CryptoKey;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const writeTransaction = database.transaction(STORE, 'readwrite');
    await requestResult(writeTransaction.objectStore(STORE).put(key, KEY));
    return key;
  } finally { database.close(); }
};
