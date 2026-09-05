import { Terminal } from '@xterm/xterm';
import { TerminalChunkSanitizer } from '../security/untrusted-text';

export type TerminalLifecycleEvent =
  | { kind: 'terminated'; reason: string }
  | { kind: 'output' };

type TerminalLike = Pick<Terminal, 'open' | 'write' | 'dispose'>;
type TerminalFactory = () => TerminalLike;

const BATCH_BYTES = 64 * 1024;
const BATCH_DELAY_MS = 50;
const encoder = new TextEncoder();

const takeBytes = (value: string): [string, string] => {
  if (encoder.encode(value).byteLength <= BATCH_BYTES) return [value, ''];
  let bytes = 0;
  let index = 0;
  for (const character of value) {
    const next = encoder.encode(character).byteLength;
    if (bytes + next > BATCH_BYTES) break;
    bytes += next;
    index += character.length;
  }
  return [value.slice(0, index), value.slice(index)];
};

/** Owns only the xterm rendering lifecycle; it intentionally installs no link or clipboard addons. */
export class TerminalManager {
  private readonly sanitizer = new TerminalChunkSanitizer();
  private terminal: TerminalLike | null = null;
  private pending = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly createTerminal: TerminalFactory = () => new Terminal({ scrollback: 5000 })) {}

  mount(element: HTMLElement): void {
    if (this.disposed || this.terminal) return;
    this.terminal = this.createTerminal();
    this.terminal.open(element);
  }

  write(chunk: string): void {
    if (this.disposed) return;
    this.pending += this.sanitizer.write(chunk);
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), BATCH_DELAY_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = '';
    this.terminal?.dispose();
    this.terminal = null;
  }

  private flush(): void {
    this.timer = null;
    if (this.disposed || this.pending.length === 0) return;
    const [batch, remaining] = takeBytes(this.pending);
    this.pending = remaining;
    this.terminal?.write(batch);
    if (this.pending.length > 0) this.timer = setTimeout(() => this.flush(), BATCH_DELAY_MS);
  }
}
