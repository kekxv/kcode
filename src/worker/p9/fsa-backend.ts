import { hasWorkspaceCapability } from '../../security/capabilities';
import { isSensitivePath } from '../../security/sensitive-paths';
import type { WorkspaceCapability } from '../../types/protocol';
import type { WorkspacePath } from '../../utils/path';
import { ERRNO, type LinuxErrno } from './constants';

export const FSA_OPERATION_TIMEOUT_MS = 30_000;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export class P9Error extends Error {
  constructor(readonly errno: LinuxErrno, message: string) { super(message); this.name = 'P9Error'; }
}

const p9 = (errno: LinuxErrno, message: string): never => { throw new P9Error(errno, message); };
const textEncoder = new TextEncoder();
const mapDomException = (error: unknown): never => {
  if (error instanceof P9Error) throw error;
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') return p9(ERRNO.ENOENT, 'Workspace entry does not exist.');
    if (error.name === 'TypeMismatchError') return p9(ERRNO.ENOTDIR, 'Workspace entry has the wrong type.');
    if (error.name === 'InvalidModificationError') return p9(ERRNO.ENOTEMPTY, 'Directory is not empty.');
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return p9(ERRNO.EACCES, 'Workspace access denied.');
  }
  return p9(ERRNO.EIO, 'File System Access operation failed.');
};
const deadline = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new P9Error(ERRNO.ETIMEDOUT, 'File System Access operation timed out.')), FSA_OPERATION_TIMEOUT_MS); })]);
  } finally { if (timer) clearTimeout(timer); }
};
const checkSegments = (segments: readonly string[]): void => {
  if (segments.length > 64) p9(ERRNO.EINVAL, 'Path depth exceeds limit.');
  for (const name of segments) if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0') || textEncoder.encode(name).byteLength > 255) p9(ERRNO.EINVAL, 'Invalid workspace entry name.');
  if (isSensitivePath(segments as WorkspacePath)) p9(ERRNO.EACCES, 'Protected workspace path.');
};

export type FsaEntry = { name: string; kind: FileSystemHandleKind; handle: FileSystemHandle };
export type FsaStat = { kind: FileSystemHandleKind; size: number; lastModified: number };
export type FsaSnapshot = { exists: boolean; kind?: FileSystemHandleKind; bytes?: Uint8Array; lastModified?: number; size?: number };
export type FsaBackendPolicy = readonly WorkspaceCapability[];

/** FSA-only workspace boundary. It never accepts or constructs host path strings. */
export class FsaBackend {
  private readonly locks = new Map<string, Promise<void>>();
  private constructor(private readonly root: FileSystemDirectoryHandle, private policy: FsaBackendPolicy) {}

  static async attach(root: FileSystemDirectoryHandle, policy: FsaBackendPolicy = ['read']): Promise<FsaBackend> {
    if (!root || root.kind !== 'directory' || typeof root.resolve !== 'function') p9(ERRNO.EACCES, 'A directory root is required.');
    const backend = new FsaBackend(root, Object.freeze([...policy]));
    await backend.confine(root, []);
    return backend;
  }

  setPolicy(policy: FsaBackendPolicy): void { this.policy = Object.freeze([...policy]); }
  getPolicy(): readonly WorkspaceCapability[] { return this.policy; }

  async read(segments: readonly string[], offset: number, count: number): Promise<Uint8Array> {
    this.require('read'); checkSegments(segments); this.offset(offset); this.count(count);
    const handle = await this.file(segments);
    try { const file = await deadline(handle.getFile()); return new Uint8Array(await deadline(file.slice(offset, Math.min(file.size, offset + count)).arrayBuffer())); } catch (error) { return mapDomException(error); }
  }

  async write(segments: readonly string[], offset: number, data: Uint8Array): Promise<number> {
    this.require('write'); checkSegments(segments); this.offset(offset); if (!(data instanceof Uint8Array) || data.byteLength > MAX_FILE_BYTES || offset + data.byteLength > MAX_FILE_BYTES) p9(ERRNO.ENOSPC, 'File size exceeds mutation limit.');
    return this.withLocks([segments], async () => {
      const handle = await this.file(segments);
      try { const current = await deadline(handle.getFile()); if (current.size > MAX_FILE_BYTES) p9(ERRNO.ENOSPC, 'Existing file exceeds mutation limit.'); const writable = await deadline(handle.createWritable({ keepExistingData: true })); await deadline(writable.seek(offset)); await deadline(writable.write(data as unknown as FileSystemWriteChunkType)); await deadline(writable.close()); return data.byteLength; } catch (error) { return mapDomException(error); }
    });
  }

  async truncate(segments: readonly string[], size: number): Promise<void> {
    this.require('write'); checkSegments(segments); this.offset(size); if (size > MAX_FILE_BYTES) p9(ERRNO.ENOSPC, 'File size exceeds mutation limit.');
    await this.withLocks([segments], async () => { const handle = await this.file(segments); try { const writable = await deadline(handle.createWritable({ keepExistingData: true })); await deadline(writable.truncate(size)); await deadline(writable.close()); } catch (error) { mapDomException(error); } });
  }

  async stat(segments: readonly string[]): Promise<FsaStat> {
    this.require('read'); checkSegments(segments); const handle = await this.handle(segments); if (handle.kind === 'directory') return { kind: 'directory', size: 0, lastModified: 0 };
    try { const file = await deadline((handle as FileSystemFileHandle).getFile()); return { kind: 'file', size: file.size, lastModified: file.lastModified }; } catch (error) { return mapDomException(error); }
  }

  async list(segments: readonly string[]): Promise<FsaEntry[]> {
    this.require('read'); if (segments.length) checkSegments(segments); const directory = await this.directory(segments);
    const entries: FsaEntry[] = [];
    try { for await (const [name, handle] of (directory as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) { if (isSensitivePath([...segments, name] as WorkspacePath)) continue; await this.confine(handle, [...segments, name]); entries.push({ name, kind: handle.kind, handle }); } return entries.sort((a, b) => a.name.localeCompare(b.name)); } catch (error) { return mapDomException(error); }
  }

  async createFile(parent: readonly string[], name: string): Promise<FileSystemFileHandle> {
    this.require('write'); checkSegments([...parent, name]); return this.withLocks([[...parent, name]], async () => { const directory = await this.directory(parent); try { await deadline(directory.getFileHandle(name)); return p9(ERRNO.EEXIST, 'Workspace entry already exists.'); } catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') return mapDomException(error); } try { const handle = await deadline(directory.getFileHandle(name, { create: true })); await this.confine(handle, [...parent, name]); return handle; } catch (error) { return mapDomException(error); } });
  }

  async mkdir(parent: readonly string[], name: string): Promise<FileSystemDirectoryHandle> {
    this.require('write'); checkSegments([...parent, name]); return this.withLocks([[...parent, name]], async () => { const directory = await this.directory(parent); try { await deadline(directory.getDirectoryHandle(name)); return p9(ERRNO.EEXIST, 'Workspace entry already exists.'); } catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') return mapDomException(error); } try { const handle = await deadline(directory.getDirectoryHandle(name, { create: true })); await this.confine(handle, [...parent, name]); return handle; } catch (error) { return mapDomException(error); } });
  }

  async remove(parent: readonly string[], name: string, recursive = false): Promise<void> {
    this.require('delete'); checkSegments([...parent, name]); await this.withLocks([[...parent, name], parent], async () => { const directory = await this.directory(parent); try { await deadline(directory.removeEntry(name, { recursive })); } catch (error) { mapDomException(error); } });
  }

  async rename(sourceParent: readonly string[], sourceName: string, destinationParent: readonly string[], destinationName: string): Promise<void> {
    this.require('write'); this.require('delete'); checkSegments([...sourceParent, sourceName]); checkSegments([...destinationParent, destinationName]);
    await this.withLocks([[...sourceParent, sourceName], [...destinationParent, destinationName], sourceParent, destinationParent], async () => {
      const sourceDirectory = await this.directory(sourceParent); const destinationDirectory = await this.directory(destinationParent);
      let source: FileSystemFileHandle; try { source = await deadline(sourceDirectory.getFileHandle(sourceName)); } catch (error) { return mapDomException(error); }
      try { await deadline(destinationDirectory.getFileHandle(destinationName)); return p9(ERRNO.EEXIST, 'Destination already exists.'); } catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') return mapDomException(error); }
      try { const original = await deadline(source.getFile()); if (original.size > MAX_FILE_BYTES) p9(ERRNO.ENOSPC, 'File exceeds mutation limit.'); const bytes = new Uint8Array(await original.arrayBuffer()); const temporaryName = `.${destinationName}.kcode-tmp-${crypto.randomUUID()}`; const temporary = await deadline(destinationDirectory.getFileHandle(temporaryName, { create: true })); const writable = await deadline(temporary.createWritable()); await deadline(writable.write(bytes as unknown as FileSystemWriteChunkType)); await deadline(writable.close()); const verified = await deadline(temporary.getFile()); if (verified.size !== original.size) p9(ERRNO.EIO, 'Rename copy verification failed.'); await deadline(destinationDirectory.removeEntry(temporaryName)); const output = await deadline(destinationDirectory.getFileHandle(destinationName, { create: true })); const outputWritable = await deadline(output.createWritable()); await deadline(outputWritable.write(bytes as unknown as FileSystemWriteChunkType)); await deadline(outputWritable.close()); await deadline(sourceDirectory.removeEntry(sourceName)); } catch (error) { return mapDomException(error); }
    });
  }

  /** Captures a confined preimage for the journal without granting guest read authority. */
  async snapshot(segments: readonly string[]): Promise<FsaSnapshot> {
    checkSegments(segments);
    try { const handle = await this.handle(segments); if (handle.kind === 'directory') return { exists: true, kind: 'directory', size: 0 }; const file = await deadline((handle as FileSystemFileHandle).getFile()); if (file.size > MAX_FILE_BYTES) p9(ERRNO.ENOSPC, 'Journal preimage exceeds file limit.'); return { exists: true, kind: 'file', bytes: new Uint8Array(await deadline(file.arrayBuffer())), lastModified: file.lastModified, size: file.size }; } catch (error) { if (error instanceof P9Error && error.errno === ERRNO.ENOENT) return { exists: false }; throw error; }
  }

  /** Restores a preimage during rollback/recovery; this never constructs a host path. */
  async restore(segments: readonly string[], snapshot: FsaSnapshot): Promise<void> {
    checkSegments(segments); const parent = segments.slice(0, -1); const name = segments.at(-1); if (!name) return;
    await this.withLocks([segments, parent], async () => {
      const directory = await this.directory(parent);
      if (!snapshot.exists) { try { await deadline(directory.removeEntry(name, { recursive: true })); } catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') mapDomException(error); } return; }
      if (snapshot.kind === 'directory') { try { await deadline(directory.getDirectoryHandle(name, { create: true })); } catch (error) { mapDomException(error); } return; }
      try { const file = await deadline(directory.getFileHandle(name, { create: true })); const writable = await deadline(file.createWritable()); await deadline(writable.write((snapshot.bytes ?? new Uint8Array()) as unknown as FileSystemWriteChunkType)); await deadline(writable.close()); } catch (error) { mapDomException(error); }
    });
  }

  private require(capability: WorkspaceCapability): void { if (!hasWorkspaceCapability({ mode: 'workspace', capabilities: this.policy, network: { mode: 'offline' } }, capability)) p9(ERRNO.EACCES, `Missing ${capability} capability.`); }
  private offset(value: number): void { if (!Number.isSafeInteger(value) || value < 0) p9(ERRNO.EINVAL, 'Invalid file offset.'); }
  private count(value: number): void { if (!Number.isSafeInteger(value) || value < 0) p9(ERRNO.EINVAL, 'Invalid byte count.'); }
  private async handle(segments: readonly string[]): Promise<FileSystemHandle> { if (!segments.length) return this.root; let directory = this.root; for (let index = 0; index < segments.length - 1; index += 1) { try { directory = await deadline(directory.getDirectoryHandle(segments[index])); await this.confine(directory, segments.slice(0, index + 1)); } catch (error) { return mapDomException(error); } } const name = segments.at(-1)!; try { const file = await deadline(directory.getFileHandle(name)); await this.confine(file, segments); return file; } catch (fileError) { if (!(fileError instanceof DOMException) || fileError.name !== 'TypeMismatchError') { if (fileError instanceof DOMException && fileError.name === 'NotFoundError') return mapDomException(fileError); } try { const dir = await deadline(directory.getDirectoryHandle(name)); await this.confine(dir, segments); return dir; } catch (error) { return mapDomException(error); } } }
  private async file(segments: readonly string[]): Promise<FileSystemFileHandle> { const handle = await this.handle(segments); if (handle.kind !== 'file') return p9(ERRNO.EISDIR, 'Directory cannot be used as a file.'); return handle as FileSystemFileHandle; }
  private async directory(segments: readonly string[]): Promise<FileSystemDirectoryHandle> { if (!segments.length) return this.root; const handle = await this.handle(segments); if (handle.kind !== 'directory') return p9(ERRNO.ENOTDIR, 'File cannot be used as a directory.'); return handle as FileSystemDirectoryHandle; }
  private async confine(handle: FileSystemHandle, expected: readonly string[]): Promise<void> { try { const resolved = await deadline(this.root.resolve(handle)); if (!resolved || resolved.length !== expected.length || resolved.some((segment, index) => segment !== expected[index])) p9(ERRNO.EACCES, 'Handle escaped authorized workspace root.'); } catch (error) { mapDomException(error); } }
  private async withLocks<T>(paths: readonly (readonly string[])[], operation: () => Promise<T>): Promise<T> { const keys = [...new Set(paths.map((path) => path.join('/')))].sort(); const releases: Array<() => void> = []; try { for (const key of keys) { const previous = this.locks.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>((resolve) => { release = resolve; }); this.locks.set(key, previous.then(() => current)); await previous; releases.push(() => { release(); if (this.locks.get(key) === current) this.locks.delete(key); }); } return await operation(); } finally { for (const release of releases.reverse()) release(); } }
}
