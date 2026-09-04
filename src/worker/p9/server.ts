import type { WorkspaceCapability } from '../../types/protocol';
import { ERRNO, MESSAGE } from './constants';
import { P9CodecSession, P9DecodeError, Writer, toSafeBrowserNumber, unknownRequestResponse } from './codec';
import { FsaBackend, P9Error } from './fsa-backend';
import { MemoryJournalStorage, MutationJournal, OpfsJournalStorage, type JournalOriginal, type JournalRecord, type JournalStorage } from './mutation-journal';
import type { P9Request, P9Response, Qid } from './types';

export type TransactionPolicy = { transactionId: string; capabilities: readonly WorkspaceCapability[] };
type JournalFactory = (transactionId: string) => Promise<JournalStorage>;
const MAX_FIDS = 4_096; const MAX_IN_FLIGHT = 64; const MAX_QIDS = 100_000; const MAX_QUEUED_MUTATION_BYTES = 16 * 1024 * 1024;
type Fid = { pathSegments: string[]; openMode: number | null };
const qidType = (kind: FileSystemHandleKind): number => kind === 'directory' ? 0x80 : 0;

/** Stateful 9P2000.L adapter with bounded fid, request, QID, and mutation queues. */
export class P9Server {
  private backend: FsaBackend | null;
  private readonly codec = new P9CodecSession();
  private readonly fids = new Map<number, Fid>();
  private readonly qids = new Map<string, bigint>();
  private readonly suppressedTags = new Set<number>();
  private inFlight = 0;
  private queuedMutationBytes = 0;
  private transaction: TransactionPolicy | null = null;
  private journal: MutationJournal | null = null;
  private journalTransactionId: string | null = null;
  private readonly activeMutations = new Set<number>();
  private mutationPoisoned = false;
  constructor(backend?: FsaBackend, private readonly journalFactory: JournalFactory = async (transactionId) => {
    if (typeof navigator !== 'undefined' && typeof navigator.storage !== 'undefined') return OpfsJournalStorage.open(transactionId);
    return new MemoryJournalStorage();
  }) { this.backend = backend ?? null; }
  async setRoot(root: FileSystemDirectoryHandle, policy: readonly WorkspaceCapability[] = ['read']): Promise<void> { this.backend = await FsaBackend.attach(root, policy); this.fids.clear(); this.qids.clear(); this.transaction = null; this.journal = null; this.journalTransactionId = null; this.mutationPoisoned = false; }
  setTransactionPolicy(policy: TransactionPolicy | null): void { this.transaction = policy ? { transactionId: policy.transactionId, capabilities: Object.freeze([...policy.capabilities]) } : null; this.backend?.setPolicy(this.transaction?.capabilities ?? ['read']); if (!policy) this.mutationPoisoned = false; }
  async commitTransaction(): Promise<void> { const journal = this.journal; if (!journal) return; if (this.mutationPoisoned) throw new P9Error(ERRNO.EBUSY, 'Transaction requires rollback.'); await journal.commit(); this.journal = null; this.journalTransactionId = null; }
  async rollbackTransaction(): Promise<void> { const journal = this.journal; if (!journal) return; const backend = this.needBackend(); await journal.rollback(async (path, original) => backend.restore(path.split('/'), original)); this.journal = null; this.journalTransactionId = null; this.mutationPoisoned = false; }
  async recoverTransaction(): Promise<void> { await this.rollbackTransaction(); }

  async handle(frame: Uint8Array, reply: (response: Uint8Array) => void): Promise<void> {
    if (this.inFlight >= MAX_IN_FLIGHT) { this.replyRaw(frame, { type: 'Rlerror', tag: this.tag(frame), errno: ERRNO.EBUSY }, reply); return; }
    this.inFlight += 1;
    let request: P9Request | null = null;
    try {
      request = this.codec.decodeRequest(frame);
      if (request.type === 'Tflush') { this.suppressedTags.add(request.oldtag); if (this.activeMutations.has(request.oldtag)) { this.mutationPoisoned = true; this.journal?.markNeedsRollback(); } this.respond({ type: 'Rflush', tag: request.tag }, reply); return; }
      const response = await this.dispatch(request);
      if (!this.suppressedTags.delete(request.tag)) this.respond(response, reply);
    } catch (error) {
      const tag = request?.tag ?? this.tag(frame);
      if (!this.suppressedTags.delete(tag)) this.respond({ type: 'Rlerror', tag, errno: this.errno(error) }, reply);
    } finally { this.inFlight -= 1; }
  }

  private async dispatch(request: P9Request): Promise<P9Response> {
    if (request.type === 'Tunknown') return unknownRequestResponse(request);
    if (request.type === 'Tversion') { this.fids.clear(); this.qids.clear(); return { type: 'Rversion', tag: request.tag, msize: request.msize, version: request.version === '9P2000.L' ? '9P2000.L' : 'unknown' }; }
    const backend = this.needBackend();
    switch (request.type) {
      case 'Tattach': {
        if (this.fids.has(request.fid)) throw new P9Error(ERRNO.EBADF, 'Fid is already in use.'); if (this.fids.size >= MAX_FIDS) throw new P9Error(ERRNO.EBUSY, 'Fid limit reached.'); this.fids.set(request.fid, { pathSegments: [], openMode: null }); return { type: 'Rattach', tag: request.tag, qid: await this.qid([]) };
      }
      case 'Twalk': return this.walk(request);
      case 'Tlopen': { const fid = this.fid(request.fid); const stat = await backend.stat(fid.pathSegments); fid.openMode = request.flags; return { type: 'Rlopen', tag: request.tag, qid: await this.qid(fid.pathSegments, stat.kind), iounit: 0 }; }
      case 'Tlcreate': { const fid = this.fid(request.fid); const path = [...fid.pathSegments, request.name]; const handle = await this.mutate(request.tag, 'create', [{ path, resultingBytes: 0 }], () => backend.createFile(fid.pathSegments, request.name)); fid.pathSegments = path; fid.openMode = request.flags; return { type: 'Rlcreate', tag: request.tag, qid: await this.qid(fid.pathSegments, handle.kind), iounit: 0 }; }
      case 'Tread': { const fid = this.fid(request.fid); const stat = await backend.stat(fid.pathSegments); if (stat.kind === 'directory') throw new P9Error(ERRNO.EISDIR, 'Directories are read with readdir.'); return { type: 'Rread', tag: request.tag, data: await backend.read(fid.pathSegments, toSafeBrowserNumber(request.offset), request.count) }; }
      case 'Twrite': { const fid = this.fid(request.fid); const before = await backend.snapshot(fid.pathSegments); const resultingBytes = Math.max(before.size ?? 0, toSafeBrowserNumber(request.offset) + request.data.byteLength); const count = await this.mutate(request.tag, 'write', [{ path: fid.pathSegments, resultingBytes, original: before }], () => backend.write(fid.pathSegments, toSafeBrowserNumber(request.offset), request.data), request.data.byteLength); return { type: 'Rwrite', tag: request.tag, count }; }
      case 'Tclunk': this.needFid(request.fid); this.fids.delete(request.fid); return { type: 'Rclunk', tag: request.tag };
      case 'Tgetattr': { const fid = this.fid(request.fid); const stat = await backend.stat(fid.pathSegments); const isDirectory = stat.kind === 'directory'; return { type: 'Rgetattr', tag: request.tag, valid: 0xffffn, qid: await this.qid(fid.pathSegments, stat.kind), mode: isDirectory ? 0o40555 : 0o100444, uid: 0, gid: 0, nlink: 1n, rdev: 0n, size: BigInt(stat.size), blksize: 4096n, blocks: BigInt(Math.ceil(stat.size / 512)), atimeSec: 0n, atimeNsec: 0n, mtimeSec: BigInt(Math.floor(stat.lastModified / 1000)), mtimeNsec: 0n, ctimeSec: BigInt(Math.floor(stat.lastModified / 1000)), ctimeNsec: 0n, btimeSec: 0n, btimeNsec: 0n, gen: 0n, dataVersion: 0n }; }
      case 'Tsetattr': { const fid = this.fid(request.fid); if (request.valid & 0x8) { const size = toSafeBrowserNumber(request.size); await this.mutate(request.tag, 'write', [{ path: fid.pathSegments, resultingBytes: size }], () => backend.truncate(fid.pathSegments, size)); } return { type: 'Rsetattr', tag: request.tag }; }
      case 'Treaddir': return { type: 'Rreaddir', tag: request.tag, data: await this.readdir(this.fid(request.fid).pathSegments, toSafeBrowserNumber(request.offset), request.count) };
      case 'Tfsync': this.needFid(request.fid); return { type: 'Rfsync', tag: request.tag };
      case 'Tmkdir': { const dir = this.fid(request.fid); const path = [...dir.pathSegments, request.name]; const created = await this.mutate(request.tag, 'create', [{ path, resultingBytes: 0 }], () => backend.mkdir(dir.pathSegments, request.name)); return { type: 'Rmkdir', tag: request.tag, qid: await this.qid(path, created.kind) }; }
      case 'Trenameat': { const oldDir = this.fid(request.olddirfid); const newDir = this.fid(request.newdirfid); const source = [...oldDir.pathSegments, request.oldname]; const destination = [...newDir.pathSegments, request.newname]; const snapshot = await backend.snapshot(source); await this.mutate(request.tag, 'rename', [{ path: source, resultingBytes: 0, original: snapshot }, { path: destination, resultingBytes: snapshot.size ?? 0 }], () => backend.rename(oldDir.pathSegments, request.oldname, newDir.pathSegments, request.newname)); return { type: 'Rrenameat', tag: request.tag }; }
      case 'Tunlinkat': { const dir = this.fid(request.dirfid); const path = [...dir.pathSegments, request.name]; await this.mutate(request.tag, 'delete', [{ path, resultingBytes: 0 }], () => backend.remove(dir.pathSegments, request.name, (request.flags & 0x200) !== 0)); return { type: 'Runlinkat', tag: request.tag }; }
    }
    throw new P9Error(ERRNO.ENOSYS, 'Unsupported 9P request.');
  }
  private async walk(request: Extract<P9Request, { type: 'Twalk' }>): Promise<P9Response> { const source = this.fid(request.fid); if (request.newfid !== request.fid && this.fids.has(request.newfid)) throw new P9Error(ERRNO.EBADF, 'New fid already exists.'); if (request.newfid !== request.fid && this.fids.size >= MAX_FIDS) throw new P9Error(ERRNO.EBUSY, 'Fid limit reached.'); let path = [...source.pathSegments]; const qids: Qid[] = []; for (const name of request.wnames) { if (name === '..') { if (path.length) path.pop(); } else { try { const stat = await this.needBackend().stat([...path, name]); path.push(name); qids.push(await this.qid(path, stat.kind)); } catch (error) { if (!qids.length) throw error; break; } } } this.fids.set(request.newfid, { pathSegments: path, openMode: null }); return { type: 'Rwalk', tag: request.tag, qids }; }
  private async mutate<T>(tag: number, operation: JournalRecord['operation'], entries: Array<{ path: readonly string[]; resultingBytes: number; original?: JournalOriginal }>, apply: () => Promise<T>, queuedBytes = 0): Promise<T> {
    if (!this.transaction) throw new P9Error(ERRNO.EACCES, 'Mutations require an approved transaction.');
    if (this.mutationPoisoned || this.journal?.summary().state === 'needs-rollback') throw new P9Error(ERRNO.EBUSY, 'Transaction requires rollback.');
    this.reserveMutation(queuedBytes);
    this.activeMutations.add(tag);
    try {
      const journal = await this.ensureJournal();
      const backend = this.needBackend();
      for (const entry of entries) {
        const original = entry.original ?? await backend.snapshot(entry.path);
        await journal.record({ path: entry.path.join('/'), operation, original, resultingBytes: entry.resultingBytes });
      }
      return await apply();
    } catch (error) {
      if (this.mutationPoisoned || (error instanceof P9Error && error.errno === ERRNO.ETIMEDOUT)) {
        this.mutationPoisoned = true;
        this.journal?.markNeedsRollback();
      }
      throw error;
    } finally { this.activeMutations.delete(tag); this.queuedMutationBytes -= queuedBytes; }
  }
  private async ensureJournal(): Promise<MutationJournal> {
    const transaction = this.transaction;
    if (!transaction) throw new P9Error(ERRNO.EACCES, 'Mutations require an approved transaction.');
    if (this.journal && this.journalTransactionId === transaction.transactionId) return this.journal;
    const storage = await this.journalFactory(transaction.transactionId);
    const key = typeof navigator === 'undefined' || typeof (navigator.storage as unknown as { getDirectory?: unknown } | undefined)?.getDirectory !== 'function'
      ? crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      : undefined;
    this.journal = key ? await MutationJournal.begin(transaction.transactionId, storage, key) : await MutationJournal.begin(transaction.transactionId, storage);
    this.journalTransactionId = transaction.transactionId;
    return this.journal;
  }
  private async readdir(path: readonly string[], offset: number, count: number): Promise<Uint8Array> { const entries = await this.needBackend().list(path); const writer = new Writer(count); for (let index = offset; index < entries.length; index += 1) { const entry = entries[index]; const item = new Writer(count).qid(await this.qid([...path, entry.name], entry.kind)).u64(BigInt(index + 1)).u8(qidType(entry.kind)).string(entry.name).finish(); if (writer.finish().byteLength + item.byteLength > count) break; writer.bytes(item); } return writer.finish(); }
  private async qid(path: readonly string[], knownKind?: FileSystemHandleKind): Promise<Qid> { const key = path.join('/'); let id = this.qids.get(key); if (id === undefined) { if (this.qids.size >= MAX_QIDS) throw new P9Error(ERRNO.ENOSPC, 'QID map limit reached.'); id = BigInt(this.qids.size + 1); this.qids.set(key, id); } const kind = knownKind ?? (await this.needBackend().stat(path)).kind; return { type: qidType(kind), version: 0, path: id }; }
  private fid(id: number): Fid { const fid = this.fids.get(id); if (!fid) throw new P9Error(ERRNO.EBADF, 'Unknown fid.'); return fid; }
  private needFid(id: number): void { this.fid(id); }
  private needBackend(): FsaBackend { if (!this.backend) throw new P9Error(ERRNO.EACCES, 'No workspace attached.'); return this.backend; }
  private reserveMutation(bytes: number): void { if (bytes > MAX_QUEUED_MUTATION_BYTES - this.queuedMutationBytes) throw new P9Error(ERRNO.ENOSPC, 'Queued mutation limit reached.'); this.queuedMutationBytes += bytes; }
  private errno(error: unknown): typeof ERRNO[keyof typeof ERRNO] { if (error instanceof P9Error) return error.errno; if (error instanceof P9DecodeError) return ERRNO.EINVAL; return ERRNO.EIO; }
  private respond(response: P9Response, reply: (response: Uint8Array) => void): void { reply(this.codec.encodeResponse(response)); }
  private replyRaw(frame: Uint8Array, response: P9Response, reply: (response: Uint8Array) => void): void { try { this.respond(response, reply); } catch { const bytes = new Uint8Array(11); const view = new DataView(bytes.buffer); view.setUint32(0, 11, true); bytes[4] = MESSAGE.Rlerror; view.setUint16(5, response.tag, true); view.setUint32(7, ERRNO.EBUSY, true); reply(bytes); } }
  private tag(frame: Uint8Array): number { return frame instanceof Uint8Array && frame.byteLength >= 7 ? new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(5, true) : 0xffff; }
}
