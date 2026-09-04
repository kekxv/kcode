import { V86, type V86Options } from 'v86';
import { P9Server } from './p9/server';

export const VM_MEMORY_BYTES = 256 * 1024 * 1024;
export const MAX_SERIAL_DELTA_BYTES = 64 * 1024;
export const MAX_COMMAND_SERIAL_BYTES = 8 * 1024 * 1024;
export const VM_BOOT_TIMEOUT_MS = 30_000;

type V86Emulator = Pick<V86, 'add_listener' | 'serial0_send' | 'destroy'>;
type V86Constructor = new (options: V86Options) => V86Emulator;
type AssetUrlResolver = (name: string) => string;

export type V86RuntimeBootConfig = {
  /** Snapshots are valid only for the offline, no-workspace/no-relay topology. */
  useSnapshot?: boolean;
};

type V86RuntimeDependencies = {
  V86?: V86Constructor;
  assetUrl?: AssetUrlResolver;
  onOutputLimit?: () => void;
  readyTimeoutMs?: number;
};

const extensionAssetUrl: AssetUrlResolver = (name) => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) return chrome.runtime.getURL(`v86/${name}`);
  return new URL(`../v86/${name}`, self.location.href).href;
};

/** Owns one offline v86 instance inside one Dedicated Worker. */
export class V86Runtime {
  private readonly V86: V86Constructor;
  private readonly assetUrl: AssetUrlResolver;
  private readonly onOutputLimit?: () => void;
  private readonly readyTimeoutMs: number;
  private emulator: V86Emulator | null = null;
  private readonly p9Server = new P9Server();
  private readonly serialListeners = new Set<(delta: string) => void>();
  private readonly decoder = new TextDecoder();
  private serialBytes: number[] = [];
  private totalSerialBytes = 0;
  private flushQueued = false;
  private destroyed = false;
  private bootSerialTail = '';
  private bootReady: { loaded: boolean; guestReady: boolean; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(dependencies: V86RuntimeDependencies = {}) {
    this.V86 = dependencies.V86 ?? V86;
    this.assetUrl = dependencies.assetUrl ?? extensionAssetUrl;
    this.onOutputLimit = dependencies.onOutputLimit;
    this.readyTimeoutMs = dependencies.readyTimeoutMs ?? VM_BOOT_TIMEOUT_MS;
  }

  async boot(config: V86RuntimeBootConfig = {}): Promise<void> {
    if (this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_BOOTABLE');
    const ready = this.waitForReady();
    const options: V86Options = {
      wasm_path: this.assetUrl('v86.wasm'),
      bios: { url: this.assetUrl('seabios.bin') },
      vga_bios: { url: this.assetUrl('vgabios.bin') },
      bzimage: { url: this.assetUrl('vmlinuz-virt') },
      initrd: { url: this.assetUrl('kcode-initramfs') },
      memory_size: VM_MEMORY_BYTES,
      autostart: true,
      // Snapshot capture uses the interpreter so two fresh states are byte-identical.
      disable_jit: true,
      cmdline: 'console=ttyS0',
      // Preserve the single virtio-9P device for the authorized Task 7 backend.
      filesystem: { handle9p: (request, reply) => { void this.p9Server.handle(request, reply); } },
    };
    if (config.useSnapshot !== false) options.initial_state = { url: this.assetUrl('alpine-state.bin.zst') };
    try {
      const emulator = new this.V86(options);
      this.emulator = emulator;
      emulator.add_listener('emulator-loaded', () => {
        if (this.bootReady) {
          this.bootReady.loaded = true;
          // A restored snapshot resumes after its original ready marker. This
          // command is consumed only once the serial shell is responsive, so
          // it supplies the same readiness proof for cold and snapshot boots.
          this.serialSend("printf 'KCODE_GUEST_READY\\n' >/dev/ttyS0\n");
          this.finishBootIfReady();
        }
      });
      emulator.add_listener('serial0-output-byte', (byte) => this.receiveSerialByte(byte));
    } catch (error) {
      this.failBoot(error instanceof Error ? error : new Error('VM_BOOT_FAILED'));
    }
    await ready;
  }

  /** Binds only the authorized directory, then mounts it only at the guest /work boundary. */
  async attachWorkspace(handle: FileSystemDirectoryHandle): Promise<void> {
    if (!this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_READY');
    await this.p9Server.setRoot(handle, ['read']);
    this.serialSend('mkdir -p /work; mountpoint -q /work || mount -t 9p -o trans=virtio,version=9p2000.L,cache=none host9p /work\n');
  }

  serialSend(data: string): void {
    if (!this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_READY');
    this.emulator.serial0_send(data);
  }

  onSerial(listener: (delta: string) => void): () => void {
    this.serialListeners.add(listener);
    return () => this.serialListeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.failBoot(new Error('VM_RUNTIME_DESTROYED'));
    this.flushSerial();
    this.serialListeners.clear();
    this.emulator?.destroy();
    this.emulator = null;
  }

  private receiveSerialByte(byte: number): void {
    if (this.destroyed || !Number.isInteger(byte) || byte < 0 || byte > 0xff) return;
    this.totalSerialBytes += 1;
    if (this.totalSerialBytes > MAX_COMMAND_SERIAL_BYTES) {
      this.destroy();
      this.onOutputLimit?.();
      return;
    }
    this.serialBytes.push(byte);
    if (this.serialBytes.length >= MAX_SERIAL_DELTA_BYTES) {
      this.flushSerial();
      return;
    }
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flushSerial());
    }
  }

  private flushSerial(): void {
    this.flushQueued = false;
    if (this.serialBytes.length === 0) return;
    const bytes = Uint8Array.from(this.serialBytes);
    this.serialBytes = [];
    const delta = this.decoder.decode(bytes, { stream: true });
    if (delta.length === 0) return;
    this.forwardSerialText(delta);
  }

  /** Splits on Unicode scalar boundaries so each structured-clone payload is bounded by encoded UTF-8 bytes. */
  private forwardSerialText(text: string): void {
    let start = 0;
    let encodedBytes = 0;
    for (let index = 0; index < text.length;) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) break;
      const scalar = String.fromCodePoint(codePoint);
      const scalarBytes = new TextEncoder().encode(scalar).byteLength;
      if (encodedBytes > 0 && encodedBytes + scalarBytes > MAX_SERIAL_DELTA_BYTES) {
        this.forwardSerialDelta(text.slice(start, index));
        start = index;
        encodedBytes = 0;
      }
      encodedBytes += scalarBytes;
      index += scalar.length;
    }
    if (start < text.length) this.forwardSerialDelta(text.slice(start));
  }

  private forwardSerialDelta(delta: string): void {
    if (this.bootReady) {
      this.bootSerialTail = `${this.bootSerialTail}${delta}`.slice(-64);
      this.bootReady.guestReady ||= this.bootSerialTail.includes('KCODE_GUEST_READY');
      this.finishBootIfReady();
    }
    for (const listener of this.serialListeners) listener(delta);
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failBoot(new Error('VM_BOOT_TIMEOUT')), this.readyTimeoutMs);
      this.bootSerialTail = '';
      this.bootReady = { loaded: false, guestReady: false, resolve, reject, timer };
    });
  }

  private finishBootIfReady(): void {
    const ready = this.bootReady;
    if (!ready || !ready.loaded || !ready.guestReady) return;
    clearTimeout(ready.timer);
    this.bootReady = null;
    ready.resolve();
  }

  private failBoot(error: Error): void {
    const ready = this.bootReady;
    if (!ready) return;
    clearTimeout(ready.timer);
    this.bootReady = null;
    ready.reject(error);
  }
}
