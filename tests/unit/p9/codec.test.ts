import { describe, expect, it } from 'vitest';
import {
  ERRNO,
  P9CodecSession,
  P9DecodeError,
  P9_MIN_MSIZE,
  Reader,
  Writer,
  decodeRequest,
  encodeResponse,
  unknownRequestResponse,
} from '../../../src/worker/p9/codec';

const frame = (type: number, body: Uint8Array, tag = 1): Uint8Array => {
  const value = new Uint8Array(7 + body.byteLength);
  const view = new DataView(value.buffer);
  view.setUint32(0, value.byteLength, true);
  value[4] = type;
  view.setUint16(5, tag, true);
  value.set(body, 7);
  return value;
};

const versionFrame = (msize: number): Uint8Array => frame(100, Uint8Array.from([
  msize & 0xff, (msize >>> 8) & 0xff, (msize >>> 16) & 0xff, (msize >>> 24) & 0xff,
  0x08, 0x00, ...new TextEncoder().encode('9P2000.L'),
]));

const readRequest = (type: 40 | 116, count: number): Uint8Array => {
  const body = new Uint8Array(16);
  new DataView(body.buffer).setUint32(12, count, true);
  return frame(type, body);
};

const negotiatedMinimumSession = (): P9CodecSession => {
  const session = new P9CodecSession();
  session.decodeRequest(versionFrame(P9_MIN_MSIZE));
  session.encodeResponse({ type: 'Rversion', tag: 1, msize: P9_MIN_MSIZE, version: '9P2000.L' });
  return session;
};

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

  it('rejects Tversion values below the protocol minimum msize', () => {
    const frame = Uint8Array.from([
      0x15, 0, 0, 0, 100, 0x01, 0x00, 0xff, 0x00, 0x00, 0x00,
      0x08, 0x00, ...new TextEncoder().encode('9P2000.L'),
    ]);
    expect(() => decodeRequest(frame)).toThrow(P9DecodeError);
  });

  it('limits post-version frames and responses to the negotiated msize', () => {
    const session = new P9CodecSession();
    const version = Uint8Array.from([
      0x15, 0, 0, 0, 100, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00,
      0x08, 0x00, ...new TextEncoder().encode('9P2000.L'),
    ]);
    session.decodeRequest(version);
    session.encodeResponse({ type: 'Rversion', tag: 1, msize: 512, version: '9P2000.L' });

    const oversized = new Uint8Array(513);
    new DataView(oversized.buffer).setUint32(0, 513, true);
    oversized[4] = 0xfe;
    expect(() => session.decodeRequest(oversized)).toThrow('Invalid frame length.');
    expect(() => session.encodeResponse({ type: 'Rreaddir', tag: 2, data: new Uint8Array(502) })).toThrow(P9DecodeError);
  });

  it('requires an Rversion selection no larger than its Tversion offer', () => {
    const session = new P9CodecSession();
    const version = Uint8Array.from([
      0x15, 0, 0, 0, 100, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00,
      0x08, 0x00, ...new TextEncoder().encode('9P2000.L'),
    ]);
    session.decodeRequest(version);
    expect(() => session.encodeResponse({ type: 'Rversion', tag: 1, msize: 513, version: '9P2000.L' })).toThrow(P9DecodeError);
  });

  it('rejects an Rversion whose encoded frame exceeds its selected msize', () => {
    expect(() => encodeResponse({ type: 'Rversion', tag: 1, msize: P9_MIN_MSIZE, version: 'x'.repeat(P9_MIN_MSIZE) })).toThrow(P9DecodeError);
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

  it('validates Reader input before resolving its default end offset', () => {
    expect(() => new Reader(null as unknown as Uint8Array)).toThrow(P9DecodeError);
    expect(() => new Reader([] as unknown as Uint8Array)).toThrow(P9DecodeError);
  });

  it('rejects Tread and Treaddir counts larger than negotiated response capacity', () => {
    const session = negotiatedMinimumSession();
    expect(() => session.decodeRequest(readRequest(116, 0xffff_ffff))).toThrow(P9DecodeError);
    expect(() => session.decodeRequest(readRequest(40, 0xffff_ffff))).toThrow(P9DecodeError);
  });

  it('accepts Tread and Treaddir counts at negotiated response capacity', () => {
    const session = negotiatedMinimumSession();
    const maximumCount = P9_MIN_MSIZE - 7 - 4;
    expect(session.decodeRequest(readRequest(116, maximumCount))).toMatchObject({ type: 'Tread', count: maximumCount });
    expect(session.decodeRequest(readRequest(40, maximumCount))).toMatchObject({ type: 'Treaddir', count: maximumCount });
  });

  it('makes Writer.u64 reject non-bigint values with a typed codec error', () => {
    expect(() => new Writer().u64(1 as unknown as bigint)).toThrow(P9DecodeError);
    expect(() => new Writer().qid(null as unknown as { type: number; version: number; path: bigint })).toThrow(P9DecodeError);
  });

  it('makes Writer.u64 reject values outside the unsigned 64-bit range', () => {
    expect(() => new Writer().u64(-1n)).toThrow(P9DecodeError);
    expect(() => new Writer().u64(1n << 64n)).toThrow(P9DecodeError);
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
