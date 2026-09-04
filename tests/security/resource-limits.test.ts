import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, P9DecodeError, decodeRequest, toSafeBrowserNumber } from '../../src/worker/p9/codec';

const next = (state: number): number => (Math.imul(state, 1664525) + 1013904223) >>> 0;

describe('9P codec resource limits', () => {
  it('rejects frames over the negotiated maximum before decoding payloads', () => {
    expect(() => decodeRequest(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(P9DecodeError);
  });

  it('rejects paths deeper than 64 components', () => {
    const names = Array.from({ length: 65 }, () => 'x');
    const payload = [
      0, 0, 0, 0, 1, 0, 0, 0, 65, 0,
      ...names.flatMap((name) => [1, 0, name.charCodeAt(0)]),
    ];
    const size = 7 + payload.length;
    expect(() => decodeRequest(Uint8Array.from([size, 0, 0, 0, 110, 1, 0, ...payload]))).toThrow(P9DecodeError);
  });

  it('does not coerce unsafe 64-bit values for browser filesystem APIs', () => {
    expect(() => toSafeBrowserNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(P9DecodeError);
  });

  it('handles 10,000 deterministic adversarial frames with typed bounded outcomes', () => {
    let state = 0x6d2b79f5;
    const messageTypes = [100, 104, 108, 110, 12, 14, 116, 118, 120, 24, 26, 40, 50, 72, 74, 76];
    const backing = new Uint8Array(4_103);
    for (let index = 0; index < 10_000; index += 1) {
      state = next(state);
      const bodyLength = state % 4_096;
      const length = 7 + bodyLength;
      const view = new DataView(backing.buffer, 0, length);
      view.setUint32(0, length, true);
      backing[4] = messageTypes[index % messageTypes.length] as number;
      view.setUint16(5, state & 0xffff, true);
      for (let byte = 7; byte < length; byte += 1) {
        state = next(state);
        backing[byte] = state & 0xff;
      }
      try {
        const request = decodeRequest(backing.subarray(0, length));
        expect(request.tag).toBeGreaterThanOrEqual(0);
      } catch (error) {
        expect(error).toBeInstanceOf(P9DecodeError);
      }
    }
  });

  it('handles corrupt counted lengths, UTF-8, and Twrite payload lengths as typed errors', () => {
    const cases = [
      Uint8Array.from([13, 0, 0, 0, 100, 1, 0, 0, 1, 0, 0, 0xff, 0xff]),
      Uint8Array.from([14, 0, 0, 0, 100, 1, 0, 0, 1, 0, 0, 1, 0, 0xff]),
      Uint8Array.from([23, 0, 0, 0, 118, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]),
    ];
    for (const frame of cases) expect(() => decodeRequest(frame)).toThrow(P9DecodeError);
  });
});
