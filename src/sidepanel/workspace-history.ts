import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { WorkRecord } from './work-history';

const DIRECTORY = '.session';
const FILE = 'kcode-history.sqlite';
export type RecoveryCheckpoint = {
  updatedAt: number;
  provider: WorkRecord['provider'];
  task: string;
  phase: 'running' | 'completed' | 'failed' | 'cancelled';
  summary: string;
};

/** SQLite work history confined to the selected workspace's .session directory. */
export class WorkspaceHistoryStore {
  private sql?: Awaited<ReturnType<typeof initSqlJs>>;
  private async database(root: FileSystemDirectoryHandle, create: boolean) {
    const SQL = this.sql ??= await initSqlJs();
    const directory = await root.getDirectoryHandle(DIRECTORY, { create });
    const file = await directory.getFileHandle(FILE, { create });
    const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
    const db = new SQL.Database(bytes.byteLength ? bytes : undefined);
    if (create) {
      db.run('CREATE TABLE IF NOT EXISTS work_history (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, provider TEXT NOT NULL, task TEXT NOT NULL, outcome TEXT NOT NULL, status TEXT NOT NULL)');
      db.run("CREATE TABLE IF NOT EXISTS recovery_state (slot INTEGER PRIMARY KEY CHECK(slot = 1), updated_at INTEGER NOT NULL, provider TEXT NOT NULL, task TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('running', 'completed', 'failed', 'cancelled')), summary TEXT NOT NULL)");
    }
    return { db, file };
  }
  private async persist(db: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>, file: FileSystemFileHandle): Promise<void> {
    const writable = await file.createWritable();
    const bytes = db.export();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await writable.write(copy.buffer);
    await writable.close();
    db.close();
  }
  async append(root: FileSystemDirectoryHandle, record: WorkRecord): Promise<void> {
    const { db, file } = await this.database(root, true);
    try { db.run('INSERT OR REPLACE INTO work_history VALUES (?, ?, ?, ?, ?, ?)', [record.id, record.createdAt, record.provider, record.task, record.outcome, record.status]); await this.persist(db, file); } catch (error) { db.close(); throw error; }
  }
  async load(root: FileSystemDirectoryHandle): Promise<readonly WorkRecord[]> {
    let database: { db: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']> };
    try { database = await this.database(root, false); } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return [];
      throw error;
    }
    try {
      const result = database.db.exec('SELECT id, created_at, provider, task, outcome, status FROM work_history ORDER BY created_at DESC');
      const rows = result[0]?.values ?? [];
      return rows.map(([id, createdAt, provider, task, outcome, status]) => ({ id: String(id), createdAt: Number(createdAt), provider: provider as WorkRecord['provider'], task: String(task), outcome: String(outcome), status: status as WorkRecord['status'] }));
    } finally { database.db.close(); }
  }
  async clear(root: FileSystemDirectoryHandle): Promise<void> { const directory = await root.getDirectoryHandle(DIRECTORY, { create: true }); await directory.removeEntry(FILE).catch((error: unknown) => { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; }); }
  async saveRecovery(root: FileSystemDirectoryHandle, checkpoint: RecoveryCheckpoint): Promise<void> {
    const { db, file } = await this.database(root, true);
    try {
      db.run('INSERT OR REPLACE INTO recovery_state (slot, updated_at, provider, task, phase, summary) VALUES (1, ?, ?, ?, ?, ?)', [checkpoint.updatedAt, checkpoint.provider, checkpoint.task, checkpoint.phase, checkpoint.summary]);
      await this.persist(db, file);
    } catch (error) { db.close(); throw error; }
  }
  async loadRecovery(root: FileSystemDirectoryHandle): Promise<RecoveryCheckpoint | null> {
    let database: { db: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']> };
    try { database = await this.database(root, false); } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
    try {
      const row = database.db.exec('SELECT updated_at, provider, task, phase, summary FROM recovery_state WHERE slot = 1')[0]?.values[0];
      if (!row || !['running', 'completed', 'failed', 'cancelled'].includes(String(row[3]))) return null;
      return { updatedAt: Number(row[0]), provider: row[1] as WorkRecord['provider'], task: String(row[2]), phase: row[3] as RecoveryCheckpoint['phase'], summary: String(row[4]) };
    } catch (error) {
      if (error instanceof Error && /no such table/.test(error.message)) return null;
      throw error;
    } finally { database.db.close(); }
  }
  async clearRecovery(root: FileSystemDirectoryHandle): Promise<void> {
    let database: { db: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>; file: FileSystemFileHandle };
    try { database = await this.database(root, false); } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return;
      throw error;
    }
    try {
      database.db.run('DELETE FROM recovery_state WHERE slot = 1');
      await this.persist(database.db, database.file);
    } catch (error) {
      database.db.close();
      if (error instanceof Error && /no such table/.test(error.message)) return;
      throw error;
    }
  }
}
