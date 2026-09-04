import type { JournalSummary } from './p9/mutation-journal';

export const MAX_RETAINED_OUTPUT_BYTES = 1 * 1024 * 1024;
export const MAX_STREAM_OUTPUT_BYTES = 8 * 1024 * 1024;

export type ExecResult = {
  exitCode: number;
  output: string;
  truncated: boolean;
  durationMs: number;
  transactionId: string;
  journalSummary: JournalSummary;
};

export type SerialRuntime = {
  serialSend(data: string): void;
  onSerial(listener: (delta: string) => void): () => void;
  destroy(): void;
};

type Options = {
  nonce?: () => string;
  now?: () => number;
  onOutput?: (delta: string) => void;
  journalSummary?: (transactionId: string) => JournalSummary;
};

type ActiveExecution = {
  nonce: string;
  started: boolean;
  buffer: string;
  output: string;
  outputBytes: number;
  retainedBytes: number;
  truncated: boolean;
  transactionId: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  stop: () => void;
  resolve: (result: ExecResult) => void;
  reject: (reason: Error) => void;
};

const encoder = new TextEncoder();
const RS = '\x1e';
const US = '\x1f';
const BEGIN = `${RS}KCODE_BEGIN:`;
const END = `${RS}KCODE_END:`;
const emptyJournal = (transactionId: string): JournalSummary => ({ transactionId, state: 'clean', entries: [], journalBytes: 0, writtenBytes: 0 });
const encodedCommand = (command: string): string => btoa(String.fromCharCode(...encoder.encode(command)));

/** Executes a single nonce-framed shell script and makes terminal serial markers a disposal boundary. */
export class ExecController {
  private active: ActiveExecution | null = null;

  constructor(private readonly runtime: SerialRuntime, private readonly options: Options = {}) {}

  exec(command: string, timeoutMs = 120_000, transactionId = ''): Promise<ExecResult> {
    if (this.active) return Promise.reject(new Error('VM_EXEC_BUSY'));
    const nonce = this.options.nonce?.() ?? crypto.randomUUID();
    const startedAt = (this.options.now ?? Date.now)();
    return new Promise<ExecResult>((resolve, reject) => {
      const active: ActiveExecution = {
        nonce,
        started: false,
        buffer: '',
        output: '',
        outputBytes: 0,
        retainedBytes: 0,
        truncated: false,
        transactionId,
        startedAt,
        timeout: null as unknown as ReturnType<typeof setTimeout>,
        stop: () => undefined,
        resolve,
        reject,
      };
      active.stop = this.runtime.onSerial((delta) => this.receive(active, delta));
      active.timeout = setTimeout(() => this.fail(active, 'VM_TIMEOUT'), timeoutMs);
      this.active = active;
      try {
        this.runtime.serialSend(this.script(command, nonce));
      } catch {
        this.fail(active, 'VM_SERIAL_SEND_FAILED');
      }
    });
  }

  cancel(): boolean {
    const active = this.active;
    if (!active) return false;
    try { this.runtime.serialSend('\x03'); } catch { /* destruction below is authoritative */ }
    this.fail(active, 'VM_CANCELLED');
    return true;
  }

  outputLimit(): boolean {
    const active = this.active;
    if (!active) return false;
    this.fail(active, 'VM_OUTPUT_LIMIT');
    return true;
  }

  private script(command: string, nonce: string): string {
    const payload = encodedCommand(command);
    return `printf '\\036KCODE_BEGIN:${nonce}\\037\\n'\nprintf '%s' '${payload}' | base64 -d >'/tmp/kcode-${nonce}.sh'\nsetsid /bin/sh -c "cd /work && exec /bin/sh '/tmp/kcode-${nonce}.sh'" &\nkcode_pid=$!\nwait "$kcode_pid"\nkcode_status=$?\nkill -TERM -- "-$kcode_pid" 2>/dev/null || true\nrm -f '/tmp/kcode-${nonce}.sh'\nprintf '\\036KCODE_END:${nonce}:%s\\037\\n' "$kcode_status"\n`;
  }

  private receive(active: ActiveExecution, delta: string): void {
    if (this.active !== active) return;
    active.buffer += delta;
    this.parse(active);
  }

  private parse(active: ActiveExecution): void {
    while (this.active === active && active.buffer) {
      if (!active.started) {
        const index = active.buffer.indexOf(BEGIN);
        if (index < 0) {
          active.buffer = this.trailingPrefix(active.buffer, BEGIN);
          return;
        }
        active.buffer = active.buffer.slice(index);
        const end = active.buffer.indexOf(US);
        if (end < 0) return;
        const frame = active.buffer.slice(0, end + 1);
        active.buffer = active.buffer.slice(end + 1);
        if (frame === `${BEGIN}${active.nonce}${US}`) active.started = true;
        continue;
      }

      const index = active.buffer.indexOf(RS);
      if (index < 0) {
        this.recordOutput(active, active.buffer);
        active.buffer = '';
        return;
      }
      if (index > 0) {
        this.recordOutput(active, active.buffer.slice(0, index));
        active.buffer = active.buffer.slice(index);
        continue;
      }
      if (!`${RS}KCODE_`.startsWith(active.buffer) && !active.buffer.startsWith(`${RS}KCODE_`)) {
        // A record separator is terminal control syntax, never terminal content.
        active.buffer = active.buffer.slice(1);
        continue;
      }
      const end = active.buffer.indexOf(US);
      if (end < 0) {
        if (active.buffer.length > 512) active.buffer = '';
        return;
      }
      const frame = active.buffer.slice(0, end + 1);
      active.buffer = active.buffer.slice(end + 1);
      if (frame.startsWith(END)) {
        const status = new RegExp(`^${this.escape(END)}${this.escape(active.nonce)}:(\\d+)${this.escape(US)}$`).exec(frame);
        // A forged marker is a terminal security event too. The exit code is
        // intentionally untrusted metadata, never proof of guest cleanup.
        this.complete(active, status ? Number(status[1]) : -1);
      }
      // BEGIN and unrecognized KCODE control frames are swallowed.
    }
  }

  private recordOutput(active: ActiveExecution, text: string): void {
    if (!text || this.active !== active) return;
    const bytes = encoder.encode(text).byteLength;
    active.outputBytes += bytes;
    if (active.outputBytes > MAX_STREAM_OUTPUT_BYTES) {
      this.fail(active, 'VM_OUTPUT_LIMIT');
      return;
    }
    const remaining = MAX_RETAINED_OUTPUT_BYTES - active.retainedBytes;
    if (remaining > 0) {
      const kept = this.limitUtf8(text, remaining);
      active.output += kept;
      active.retainedBytes += encoder.encode(kept).byteLength;
      if (kept.length !== text.length) active.truncated = true;
    } else active.truncated = true;
    this.options.onOutput?.(text);
  }

  private complete(active: ActiveExecution, exitCode: number): void {
    if (this.active !== active) return;
    const durationMs = Math.max(0, (this.options.now ?? Date.now)() - active.startedAt);
    this.dispose(active);
    active.resolve({ exitCode, output: active.output, truncated: active.truncated, durationMs, transactionId: active.transactionId, journalSummary: (this.options.journalSummary ?? emptyJournal)(active.transactionId) });
  }

  private fail(active: ActiveExecution, code: string): void {
    if (this.active !== active) return;
    this.dispose(active);
    active.reject(new Error(code));
  }

  /** VM destruction precedes either resolve or reject; never wait for a guest process to cooperate. */
  private dispose(active: ActiveExecution): void {
    if (this.active !== active) return;
    this.active = null;
    clearTimeout(active.timeout);
    active.stop();
    this.runtime.destroy();
  }

  private trailingPrefix(value: string, prefix: string): string {
    const max = Math.min(value.length, prefix.length - 1);
    for (let length = max; length > 0; length -= 1) if (value.endsWith(prefix.slice(0, length))) return value.slice(-length);
    return '';
  }

  private limitUtf8(value: string, maximum: number): string {
    let bytes = 0;
    let index = 0;
    while (index < value.length) {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) break;
      const scalar = String.fromCodePoint(codePoint);
      const size = encoder.encode(scalar).byteLength;
      if (bytes + size > maximum) break;
      bytes += size;
      index += scalar.length;
    }
    return value.slice(0, index);
  }

  private escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
}
