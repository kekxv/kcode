import { indexedDB } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { P9CodecSession, Reader, Writer } from '../../../src/worker/p9/codec';
import { ERRNO, MESSAGE } from '../../../src/worker/p9/constants';
import { FsaBackend, P9Error } from '../../../src/worker/p9/fsa-backend';
import { P9Server } from '../../../src/worker/p9/server';
import { MutationJournal, OpfsJournalStorage } from '../../../src/worker/p9/mutation-journal';
import { MemoryFsaRoot } from '../../helpers/memory-fsa';

const frame = (type: number, tag: number, body: Uint8Array<ArrayBufferLike> = new Uint8Array()): Uint8Array => new Writer().u32(7 + body.byteLength).u8(type).u16(tag).bytes(body).finish();
const version = () => frame(MESSAGE.Tversion, 1, new Writer().u32(65_536).string('9P2000.L').finish());

describe('P9Server lifecycle', () => {
  it('journals a created file and removes it again on explicit rollback', async () => {
    // Break caught: a 9P create without durable preimage metadata survives rollback and leaves host changes behind.
    const root = new MemoryFsaRoot();
    const server = new P9Server(await FsaBackend.attach(root as unknown as FileSystemDirectoryHandle, ['read']));
    server.setTransactionPolicy({ transactionId: 'rollback-1', capabilities: ['read', 'write', 'delete'] });
    const replies: Uint8Array[] = [];
    await server.handle(version(), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Tattach, 2, new Writer().u32(0).u32(0xffff_ffff).string('').string('').u32(0).finish()), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Tlcreate, 3, new Writer().u32(0).string('created.txt').u32(0).u32(0).u32(0).finish()), (reply) => replies.push(reply));
    expect([replies[2][4], new DataView(replies[2].buffer, replies[2].byteOffset).getUint32(7, true)]).toEqual([MESSAGE.Rlcreate, 0]);
    expect(await root.getFileHandle('created.txt')).toBeTruthy();
    expect(() => server.setTransactionPolicy({ transactionId: 'replacement', capabilities: ['read', 'write', 'delete'] })).toThrow('Existing transaction requires finalization');
    await server.rollbackTransaction();
    await expect(root.getFileHandle('created.txt')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('negotiates, attaches a fid, and returns one reply for each accepted request', async () => {
    // Break caught: a missing fid lifecycle reply hangs the guest kernel indefinitely after its first 9P request.
    const root = new MemoryFsaRoot();
    const server = new P9Server(await FsaBackend.attach(root as unknown as FileSystemDirectoryHandle, ['read']));
    const replies: Uint8Array[] = [];
    await server.handle(version(), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Tattach, 2, new Writer().u32(0).u32(0xffff_ffff).string('').string('').u32(0).finish()), (reply) => replies.push(reply));
    expect(replies).toHaveLength(2);
    expect(new DataView(replies[0].buffer, replies[0].byteOffset).getUint8(4)).toBe(MESSAGE.Rversion);
    expect(new DataView(replies[1].buffer, replies[1].byteOffset).getUint8(4)).toBe(MESSAGE.Rattach);
  });

  it('poisons an approved transaction after an FSA mutation timeout', async () => {
    // Break caught: allowing another mutation after an unabortable timed-out write can commit host bytes whose outcome is unknown.
    const backend = {
      setPolicy: () => {},
      stat: async () => ({ kind: 'file', size: 0, lastModified: 0 }),
      snapshot: async () => ({ exists: true, kind: 'file', bytes: new Uint8Array(), size: 0, lastModified: 0 }),
      write: async () => { throw new P9Error(ERRNO.ETIMEDOUT, 'timed out'); },
      truncate: async () => {},
    } as unknown as FsaBackend;
    const server = new P9Server(backend);
    server.setTransactionPolicy({ transactionId: 'timeout-1', capabilities: ['read', 'write', 'delete'] });
    const replies: Uint8Array[] = [];
    await server.handle(version(), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Tattach, 2, new Writer().u32(0).u32(0xffff_ffff).string('').string('').u32(0).finish()), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Twrite, 4, new Writer().u32(0).u64(0n).u32(1).bytes(new Uint8Array([1])).finish()), (reply) => replies.push(reply));
    expect(new DataView(replies.at(-1)!.buffer, replies.at(-1)!.byteOffset).getUint32(7, true)).toBe(110);

    await server.handle(frame(MESSAGE.Tsetattr, 5, new Writer().u32(0).u32(8).u32(0).u32(0).u32(0).u64(0n).u64(0n).u64(0n).u64(0n).u64(0n).finish()), (reply) => replies.push(reply));
    expect(replies.at(-1)![4]).toBe(MESSAGE.Rlerror);
    expect(new DataView(replies.at(-1)!.buffer, replies.at(-1)!.byteOffset).getUint32(7, true)).toBe(16);
  });

  it('rejects recursive unlink of a nonempty directory without a subtree journal', async () => {
    // Break caught: a one-node directory preimage cannot restore recursively deleted descendants after rollback.
    const root = new MemoryFsaRoot();
    const directory = await root.getDirectoryHandle('nonempty', { create: true });
    await directory.getFileHandle('child.txt', { create: true });
    const server = new P9Server(await FsaBackend.attach(root as unknown as FileSystemDirectoryHandle, ['read', 'write', 'delete']));
    server.setTransactionPolicy({ transactionId: 'unlink-safe', capabilities: ['read', 'write', 'delete'] });
    const replies: Uint8Array[] = [];
    await server.handle(version(), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Tattach, 2, new Writer().u32(0).u32(0xffff_ffff).string('').string('').u32(0).finish()), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Tunlinkat, 3, new Writer().u32(0).string('nonempty').u32(0x200).finish()), (reply) => replies.push(reply));

    expect(replies.at(-1)![4]).toBe(MESSAGE.Rlerror);
    expect(new DataView(replies.at(-1)!.buffer, replies.at(-1)!.byteOffset).getUint32(7, true)).toBe(39);
    await expect((await root.getDirectoryHandle('nonempty')).getFileHandle('child.txt')).resolves.toBeTruthy();
  });

  it('returns WORKSPACE_CONFLICT rather than overwriting a host edit made after guest mutation', async () => {
    // Break caught: rollback must never replace a newer host file merely because the guest has a journal preimage.
    const root = new MemoryFsaRoot();
    const file = await root.getFileHandle('notes.txt', { create: true });
    const initial = await file.createWritable(); await initial.write(new TextEncoder().encode('before')); await initial.close();
    const server = new P9Server(await FsaBackend.attach(root as unknown as FileSystemDirectoryHandle, ['read', 'write', 'delete']));
    server.setTransactionPolicy({ transactionId: 'conflict-safe', capabilities: ['read', 'write', 'delete'] });
    const replies: Uint8Array[] = [];
    await server.handle(version(), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Tattach, 2, new Writer().u32(0).u32(0xffff_ffff).string('').string('').u32(0).finish()), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Twalk, 3, new Writer().u32(0).u32(1).u16(1).string('notes.txt').finish()), (reply) => replies.push(reply));
    await server.handle(frame(MESSAGE.Twrite, 4, new Writer().u32(1).u64(0n).u32(5).bytes(new TextEncoder().encode('guest')).finish()), (reply) => replies.push(reply));
    const external = await root.getFileHandle('notes.txt'); const writable = await external.createWritable(); await writable.write(new TextEncoder().encode('external')); await writable.close();

    await expect(server.rollbackTransaction()).rejects.toThrow('WORKSPACE_CONFLICT');
    const current = await (await root.getFileHandle('notes.txt')).getFile();
    expect(new TextDecoder().decode(new Uint8Array(await current.arrayBuffer()))).toBe('external');
  });

  it('recovers an encrypted unfinished OPFS transaction before accepting a workspace root', async () => {
    // Break caught: after a Worker crash, reusing the selected directory without recovery leaves a completed guest mutation on the host.
    const root = new MemoryFsaRoot();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    vi.stubGlobal('indexedDB', indexedDB);
    try {
      const file = await root.getFileHandle('recover.txt', { create: true });
      const writable = await file.createWritable(); await writable.write(new TextEncoder().encode('guest')); await writable.close();
      const backend = await FsaBackend.attach(root as unknown as FileSystemDirectoryHandle, ['read', 'write', 'delete']);
      const journal = await MutationJournal.begin('crash_recover', await OpfsJournalStorage.open('crash_recover'));
      await journal.record({ path: 'recover.txt', operation: 'create', original: { exists: false }, resultingBytes: 5 });
      await journal.setExpected('recover.txt', await backend.snapshot(['recover.txt']));

      await new P9Server().setRoot(root as unknown as FileSystemDirectoryHandle);
      await expect(root.getFileHandle('recover.txt')).rejects.toMatchObject({ name: 'NotFoundError' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
