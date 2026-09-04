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
    const backing = new Uint8Array(MAX_FRAME_BYTES + 1);
    for (let index = 0; index < 10_000; index += 1) {
      state = next(state);
      const length = index === 0 ? 0 : index === 1 ? MAX_FRAME_BYTES + 1 : state % (MAX_FRAME_BYTES + 2);
      for (let byte = 0; byte < Math.min(length, 32); byte += 1) {
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
});
