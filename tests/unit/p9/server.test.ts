import { describe, expect, it } from 'vitest';
import { P9CodecSession, Reader, Writer } from '../../../src/worker/p9/codec';
import { MESSAGE } from '../../../src/worker/p9/constants';
import { FsaBackend } from '../../../src/worker/p9/fsa-backend';
import { P9Server } from '../../../src/worker/p9/server';
import { MemoryFsaRoot } from '../../helpers/memory-fsa';

const frame = (type: number, tag: number, body: Uint8Array<ArrayBufferLike> = new Uint8Array()): Uint8Array => new Writer().u32(7 + body.byteLength).u8(type).u16(tag).bytes(body).finish();
const version = () => frame(MESSAGE.Tversion, 1, new Writer().u32(65_536).string('9P2000.L').finish());

describe('P9Server lifecycle', () => {
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
});
