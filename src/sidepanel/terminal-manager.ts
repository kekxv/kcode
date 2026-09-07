import { FitAddon } from '@xterm/addon-fit';
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
  private readonly sanitizer: TerminalChunkSanitizer;
  private terminal: TerminalLike | null = null;
  private pending = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private inputHandler: ((data: string) => void) | undefined;
  private theme: 'light' | 'dark' = 'dark';
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly createTerminal: TerminalFactory = () => new Terminal({ scrollback: 2000, convertEol: true, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, monospace', theme: { background: '#151a20', foreground: '#dce5ed' } }), interactive = false) { this.sanitizer = new TerminalChunkSanitizer(interactive); }

  mount(element: HTMLElement): void {
    if (this.disposed || this.terminal) return;
    this.terminal = this.createTerminal();
    this.terminal.open(element);
    this.setTheme(this.theme);
    if (this.terminal instanceof Terminal) {
      this.terminal.onData(data => this.inputHandler?.(data));
      const fit = new FitAddon(); this.terminal.loadAddon(fit);
      this.resizeObserver = new ResizeObserver(() => { if (element.clientWidth && element.clientHeight) fit.fit(); });
      this.resizeObserver.observe(element);
    }
  }

  onInput(handler: (data: string) => void): void { this.inputHandler = handler; }
  writeLocal(text: string): void {
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    if (this.pending) { this.terminal?.write(this.pending); this.pending = ''; }
    this.terminal?.write(text);
  }
  size(): { cols: number; rows: number } { return this.terminal instanceof Terminal ? { cols: this.terminal.cols, rows: this.terminal.rows } : { cols: 80, rows: 24 }; }
  focus(): void { if (this.terminal instanceof Terminal) this.terminal.focus(); }

  setTheme(theme: 'light' | 'dark'): void {
    this.theme = theme;
    if (this.terminal instanceof Terminal) this.terminal.options.theme = theme === 'light'
      ? { background: '#ffffff', foreground: '#26352d', cursor: '#347357', selectionBackground: '#cee6d8' }
      : { background: '#151a20', foreground: '#dce5ed', cursor: '#93ceb8', selectionBackground: '#354c43' };
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
    this.resizeObserver?.disconnect();
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
