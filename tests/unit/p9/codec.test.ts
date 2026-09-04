import { describe, expect, it } from 'vitest';
import {
  ERRNO,
  P9DecodeError,
  Reader,
  Writer,
  decodeRequest,
  encodeResponse,
  unknownRequestResponse,
} from '../../../src/worker/p9/codec';

describe('9P2000.L codec', () => {
  it('decodes the byte-exact Tversion fixture', () => {
    const tversion = Uint8Array.from([
      0x15, 0, 0, 0, 100, 0xff, 0xff, 0x00, 0x00, 0x10, 0x00,
      0x08, 0x00, ...new TextEncoder().encode('9P2000.L'),
    ]);

    expect(decodeRequest(tversion)).toEqual({
      type: 'Tversion', tag: 0xffff, msize: 1_048_576, version: '9P2000.L',
    });
  });

  it('uses little-endian primitives and UTF-8 counted strings', () => {
    const writer = new Writer();
    writer.u8(0xab).u16(0xcdef).u32(0x01234567).u64(0x0102030405060708n).string('雪');
    expect(writer.finish()).toEqual(Uint8Array.from([
      0xab, 0xef, 0xcd, 0x67, 0x45, 0x23, 0x01,
      0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
      0x03, 0x00, 0xe9, 0x9b, 0xaa,
    ]));

    const reader = new Reader(writer.finish());
    expect([reader.u8(), reader.u16(), reader.u32(), reader.u64(), reader.string()]).toEqual([
      0xab, 0xcdef, 0x01234567, 0x0102030405060708n, '雪',
    ]);
    expect(reader.remaining).toBe(0);
  });

  it('rejects a frame whose declared size differs from its actual bytes', () => {
    expect(() => decodeRequest(Uint8Array.from([8, 0, 0, 0, 108, 1, 0]))).toThrow(P9DecodeError);
  });

  it('rejects trailing bytes after a known request payload', () => {
    const frame = Uint8Array.from([10, 0, 0, 0, 108, 1, 0, 0, 0, 0]);
    expect(() => decodeRequest(frame)).toThrow(P9DecodeError);
  });

  it('rejects truncated counted strings as typed decode failures', () => {
    const frame = Uint8Array.from([13, 0, 0, 0, 100, 1, 0, 0, 0, 16, 0, 2, 0]);
    expect(() => decodeRequest(frame)).toThrow('Truncated counted string.');
  });

  it('preserves request tags in encoded responses', () => {
    expect(encodeResponse({ type: 'Rflush', tag: 0xabcd })).toEqual(
      Uint8Array.from([7, 0, 0, 0, 109, 0xcd, 0xab]),
    );
  });

  it('maps unknown message IDs to Rlerror ENOSYS with the original tag', () => {
    const request = decodeRequest(Uint8Array.from([7, 0, 0, 0, 0xfe, 0x34, 0x12]));
    expect(request).toEqual({ type: 'Tunknown', tag: 0x1234, messageType: 0xfe });
    expect(unknownRequestResponse(request)).toEqual({ type: 'Rlerror', tag: 0x1234, errno: ERRNO.ENOSYS });
    expect(encodeResponse(unknownRequestResponse(request))).toEqual(
      Uint8Array.from([11, 0, 0, 0, 7, 0x34, 0x12, 38, 0, 0, 0]),
    );
  });
});
