import { ERRNO, MAX_FRAME_BYTES, MAX_MSIZE, MAX_PATH_COMPONENT_BYTES, MAX_PATH_DEPTH, MESSAGE, P9_HEADER_BYTES, P9_MIN_MSIZE } from './constants';
import type { P9Request, P9Response, Qid, Tunknown } from './types';

export { ERRNO, MAX_FRAME_BYTES, MAX_MSIZE, MAX_PATH_COMPONENT_BYTES, MAX_PATH_DEPTH, P9_MIN_MSIZE } from './constants';
export type { P9Request, P9Response, Qid } from './types';

const MAX_U64 = (1n << 64n) - 1n;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** Every malformed or out-of-bounds packet fails with this typed error. */
export class P9DecodeError extends Error {
  readonly code = 'P9_DECODE_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'P9DecodeError';
  }
}

const fail = (message: string): never => { throw new P9DecodeError(message); };
const boundedInteger = (value: number, maximum: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0 || value > maximum) fail(`Invalid ${name}.`);
};

/** Converts protocol values only at the browser API boundary. */
export const toSafeBrowserNumber = (value: bigint): number => {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('64-bit value exceeds browser-safe range.');
  return Number(value);
};

export class Reader {
  private readonly view: DataView;
  private position: number;
  private readonly end: number;

  constructor(private readonly input: Uint8Array, start = 0, end = input.byteLength) {
    if (!(input instanceof Uint8Array)) fail('Packet must be a Uint8Array.');
    boundedInteger(start, input.byteLength, 'reader start');
    boundedInteger(end, input.byteLength, 'reader end');
    if (start > end) fail('Invalid reader bounds.');
    this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    this.position = start;
    this.end = end;
  }

  get remaining(): number { return this.end - this.position; }

  u8(): number { this.require(1); return this.view.getUint8(this.position++); }
  u16(): number { this.require(2); const value = this.view.getUint16(this.position, true); this.position += 2; return value; }
  u32(): number { this.require(4); const value = this.view.getUint32(this.position, true); this.position += 4; return value; }
  u64(): bigint { this.require(8); const value = this.view.getBigUint64(this.position, true); this.position += 8; return value; }

  bytes(length: number): Uint8Array {
    boundedInteger(length, this.remaining, 'byte length');
    const start = this.position;
    this.position += length;
    return this.input.slice(start, this.position);
  }

  string(): string {
    const length = this.u16();
    if (length > this.remaining) fail('Truncated counted string.');
    const bytes = this.bytes(length);
    try {
      return decoder.decode(bytes);
    } catch {
      return fail('Invalid UTF-8 string.');
    }
  }

  qid(): Qid { return { type: this.u8(), version: this.u32(), path: this.u64() }; }

  finish(): void { if (this.remaining !== 0) fail('Packet has trailing bytes.'); }

  private require(length: number): void {
    if (length > this.remaining) fail('Truncated packet.');
  }
}

export class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly maximum = MAX_FRAME_BYTES) {
    boundedInteger(maximum, MAX_FRAME_BYTES, 'writer maximum');
  }

  u8(value: number): this { boundedInteger(value, 0xff, 'u8'); return this.push(Uint8Array.of(value)); }
  u16(value: number): this { boundedInteger(value, 0xffff, 'u16'); const bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, value, true); return this.push(bytes); }
  u32(value: number): this { boundedInteger(value, 0xffff_ffff, 'u32'); const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return this.push(bytes); }
  u64(value: bigint): this {
    if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) fail('Invalid u64.');
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return this.push(bytes);
  }
  bytes(value: Uint8Array): this {
    if (!(value instanceof Uint8Array)) fail('Response bytes must be a Uint8Array.');
    return this.push(value);
  }
  string(value: string): this {
    if (typeof value !== 'string' || value.length > MAX_FRAME_BYTES) fail('Invalid response string.');
    const bytes = encoder.encode(value);
    if (bytes.byteLength > 0xffff) fail('Response string exceeds 16-bit length.');
    return this.u16(bytes.byteLength).bytes(bytes);
  }
  qid(value: Qid): this {
    if (!value || typeof value !== 'object') fail('Invalid QID.');
    return this.u8(value.type).u32(value.version).u64(value.path);
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }

  private push(bytes: Uint8Array): this {
    if (bytes.byteLength > this.maximum - this.length) fail('Encoded frame exceeds maximum size.');
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    return this;
  }
}

const component = (value: string): string => {
  if (encoder.encode(value).byteLength > MAX_PATH_COMPONENT_BYTES) fail('Path component exceeds 255 bytes.');
  return value;
};
const path = (value: string): string => {
  const components = value.split('/').filter(Boolean);
  if (components.length > MAX_PATH_DEPTH) fail('Path exceeds maximum depth.');
  for (const entry of components) component(entry);
  return value;
};
const validMsize = (msize: number): number => {
  boundedInteger(msize, MAX_MSIZE, 'msize');
  if (msize < P9_MIN_MSIZE) fail('Invalid negotiated msize.');
  return msize;
};

const checkedFrame = (frame: Uint8Array, maximum: number): { reader: Reader; type: number; tag: number } => {
  if (!(frame instanceof Uint8Array)) fail('Frame must be a Uint8Array.');
  if (frame.byteLength < P9_HEADER_BYTES || frame.byteLength > maximum) fail('Invalid frame length.');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const declared = view.getUint32(0, true);
  if (declared !== frame.byteLength || declared < P9_HEADER_BYTES || declared > maximum) fail('Declared frame length does not match packet.');
  return { reader: new Reader(frame, P9_HEADER_BYTES), type: view.getUint8(4), tag: view.getUint16(5, true) };
};

const decodeRequestWithin = (frame: Uint8Array, maximum: number): P9Request => {
  const { reader, type, tag } = checkedFrame(frame, maximum);
  let request: P9Request;
  switch (type) {
    case MESSAGE.Tversion: request = { type: 'Tversion', tag, msize: validMsize(reader.u32()), version: reader.string() }; break;
    case MESSAGE.Tattach: request = { type: 'Tattach', tag, fid: reader.u32(), afid: reader.u32(), uname: reader.string(), aname: path(reader.string()), nuname: reader.u32() }; break;
    case MESSAGE.Tflush: request = { type: 'Tflush', tag, oldtag: reader.u16() }; break;
    case MESSAGE.Twalk: {
      const fid = reader.u32(); const newfid = reader.u32(); const count = reader.u16();
      if (count > MAX_PATH_DEPTH) fail('Walk exceeds maximum path depth.');
      const wnames: string[] = [];
      for (let index = 0; index < count; index += 1) wnames.push(component(reader.string()));
      request = { type: 'Twalk', tag, fid, newfid, wnames };
      break;
    }
    case MESSAGE.Tlopen: request = { type: 'Tlopen', tag, fid: reader.u32(), flags: reader.u32() }; break;
    case MESSAGE.Tlcreate: request = { type: 'Tlcreate', tag, fid: reader.u32(), name: component(reader.string()), flags: reader.u32(), mode: reader.u32(), gid: reader.u32() }; break;
    case MESSAGE.Tread: request = { type: 'Tread', tag, fid: reader.u32(), offset: reader.u64(), count: reader.u32() }; break;
    case MESSAGE.Twrite: {
      const fid = reader.u32(); const offset = reader.u64(); const count = reader.u32();
      request = { type: 'Twrite', tag, fid, offset, data: reader.bytes(count) };
      break;
    }
    case MESSAGE.Tclunk: request = { type: 'Tclunk', tag, fid: reader.u32() }; break;
    case MESSAGE.Tgetattr: request = { type: 'Tgetattr', tag, fid: reader.u32(), requestMask: reader.u64() }; break;
    case MESSAGE.Tsetattr: request = { type: 'Tsetattr', tag, fid: reader.u32(), valid: reader.u32(), mode: reader.u32(), uid: reader.u32(), gid: reader.u32(), size: reader.u64(), atimeSec: reader.u64(), atimeNsec: reader.u64(), mtimeSec: reader.u64(), mtimeNsec: reader.u64() }; break;
    case MESSAGE.Treaddir: request = { type: 'Treaddir', tag, fid: reader.u32(), offset: reader.u64(), count: reader.u32() }; break;
    case MESSAGE.Tfsync: request = { type: 'Tfsync', tag, fid: reader.u32(), datasync: reader.u32() }; break;
    case MESSAGE.Tmkdir: request = { type: 'Tmkdir', tag, fid: reader.u32(), name: component(reader.string()), mode: reader.u32(), gid: reader.u32() }; break;
    case MESSAGE.Trenameat: request = { type: 'Trenameat', tag, olddirfid: reader.u32(), oldname: component(reader.string()), newdirfid: reader.u32(), newname: component(reader.string()) }; break;
    case MESSAGE.Tunlinkat: request = { type: 'Tunlinkat', tag, dirfid: reader.u32(), name: component(reader.string()), flags: reader.u32() }; break;
    default: return { type: 'Tunknown', tag, messageType: type };
  }
  reader.finish();
  return request;
};

/** Decodes a standalone frame with the global 9P transport limit. */
export const decodeRequest = (frame: Uint8Array): P9Request => decodeRequestWithin(frame, MAX_FRAME_BYTES);

export const unknownRequestResponse = (request: Pick<Tunknown, 'tag'>): P9Response => ({
  type: 'Rlerror', tag: request.tag, errno: ERRNO.ENOSYS,
});

const responseBytes = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array)) fail('Response data must be a Uint8Array.');
  return value as Uint8Array;
};

const encodeResponseWithin = (response: P9Response, maximum: number): Uint8Array => {
  if (!response || typeof response !== 'object' || typeof response.type !== 'string') fail('Invalid response.');
  if (maximum < P9_HEADER_BYTES || maximum > MAX_FRAME_BYTES) fail('Invalid response frame limit.');
  boundedInteger(response.tag, 0xffff, 'tag');
  const body = new Writer(maximum - P9_HEADER_BYTES);
  let type: number;
  switch (response.type) {
    case 'Rlerror': type = MESSAGE.Rlerror; body.u32(response.errno); break;
    case 'Rversion': type = MESSAGE.Rversion; body.u32(validMsize(response.msize)).string(response.version); break;
    case 'Rattach': type = MESSAGE.Rattach; body.qid(response.qid); break;
    case 'Rflush': type = MESSAGE.Rflush; break;
    case 'Rwalk': {
      if (!Array.isArray(response.qids) || response.qids.length > MAX_PATH_DEPTH) fail('Too many walk QIDs.');
      type = MESSAGE.Rwalk; body.u16(response.qids.length); for (const qid of response.qids) body.qid(qid); break;
    }
    case 'Rlopen': type = MESSAGE.Rlopen; body.qid(response.qid).u32(response.iounit); break;
    case 'Rlcreate': type = MESSAGE.Rlcreate; body.qid(response.qid).u32(response.iounit); break;
    case 'Rread': { const data = responseBytes(response.data); type = MESSAGE.Rread; body.u32(data.byteLength).bytes(data); break; }
    case 'Rwrite': type = MESSAGE.Rwrite; body.u32(response.count); break;
    case 'Rclunk': type = MESSAGE.Rclunk; break;
    case 'Rgetattr': type = MESSAGE.Rgetattr; body.u64(response.valid).qid(response.qid).u32(response.mode).u32(response.uid).u32(response.gid).u64(response.nlink).u64(response.rdev).u64(response.size).u64(response.blksize).u64(response.blocks).u64(response.atimeSec).u64(response.atimeNsec).u64(response.mtimeSec).u64(response.mtimeNsec).u64(response.ctimeSec).u64(response.ctimeNsec); break;
    case 'Rsetattr': type = MESSAGE.Rsetattr; break;
    case 'Rreaddir': { const data = responseBytes(response.data); type = MESSAGE.Rreaddir; body.u32(data.byteLength).bytes(data); break; }
    case 'Rfsync': type = MESSAGE.Rfsync; break;
    case 'Rmkdir': type = MESSAGE.Rmkdir; body.qid(response.qid); break;
    case 'Rrenameat': type = MESSAGE.Rrenameat; break;
    case 'Runlinkat': type = MESSAGE.Runlinkat; break;
    default: return fail('Unsupported response type.');
  }
  const payload = body.finish();
  const frame = new Writer(maximum).u32(P9_HEADER_BYTES + payload.byteLength).u8(type).u16(response.tag).bytes(payload).finish();
  if (response.type === 'Rversion' && frame.byteLength > response.msize) fail('Rversion exceeds its negotiated msize.');
  return frame;
};

/** Encodes a standalone response with the global 9P transport limit. */
export const encodeResponse = (response: P9Response): Uint8Array => encodeResponseWithin(response, MAX_FRAME_BYTES);

/**
 * Per-connection codec state. A Tversion offer is accepted once, its matching
 * Rversion selects the transport bound, and every subsequent frame is checked
 * against that bound before payload decoding or response allocation.
 */
export class P9CodecSession {
  private offeredMsize: number | null = null;
  private versionTag: number | null = null;
  private msize: number | null = null;

  get negotiatedMsize(): number | null { return this.msize; }

  decodeRequest(frame: Uint8Array): P9Request {
    const request = decodeRequestWithin(frame, this.msize ?? MAX_FRAME_BYTES);
    if (request.type === 'Tversion') {
      this.offeredMsize = request.msize;
      this.versionTag = request.tag;
      this.msize = null;
    } else if (this.msize === null) {
      fail('Tversion must be negotiated before other requests.');
    }
    return request;
  }

  encodeResponse(response: P9Response): Uint8Array {
    if (!response || typeof response !== 'object') fail('Invalid response.');
    if (response.type === 'Rversion') {
      const offeredMsize = this.offeredMsize;
      const versionTag = this.versionTag;
      if (offeredMsize === null || versionTag === null) return fail('Rversion has no Tversion offer.');
      validMsize(response.msize);
      if (response.tag !== versionTag || response.msize > offeredMsize) fail('Invalid Rversion negotiation.');
      const frame = encodeResponseWithin(response, response.msize);
      this.msize = response.msize;
      this.offeredMsize = null;
      this.versionTag = null;
      return frame;
    }
    const msize = this.msize;
    if (msize === null) return fail('Tversion must be negotiated before other responses.');
    return encodeResponseWithin(response, msize);
  }
}
