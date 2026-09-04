import { V86, type V86Options } from 'v86';

export const VM_MEMORY_BYTES = 128 * 1024 * 1024;
export const MAX_SERIAL_DELTA_BYTES = 64 * 1024;
export const MAX_COMMAND_SERIAL_BYTES = 8 * 1024 * 1024;

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
};

const extensionAssetUrl: AssetUrlResolver = (name) => chrome.runtime.getURL(`v86/${name}`);

/** Owns one offline v86 instance inside one Dedicated Worker. */
export class V86Runtime {
  private readonly V86: V86Constructor;
  private readonly assetUrl: AssetUrlResolver;
  private readonly onOutputLimit?: () => void;
  private emulator: V86Emulator | null = null;
  private readonly serialListeners = new Set<(delta: string) => void>();
  private readonly decoder = new TextDecoder();
  private serialBytes: number[] = [];
  private totalSerialBytes = 0;
  private flushQueued = false;
  private destroyed = false;

  constructor(dependencies: V86RuntimeDependencies = {}) {
    this.V86 = dependencies.V86 ?? V86;
    this.assetUrl = dependencies.assetUrl ?? extensionAssetUrl;
    this.onOutputLimit = dependencies.onOutputLimit;
  }

  async boot(config: V86RuntimeBootConfig = {}): Promise<void> {
    if (this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_BOOTABLE');
    const options: V86Options = {
      wasm_path: this.assetUrl('v86.wasm'),
      bios: { url: this.assetUrl('seabios.bin') },
      vga_bios: { url: this.assetUrl('vgabios.bin') },
      bzimage: { url: this.assetUrl('vmlinuz-virt') },
      initrd: { url: this.assetUrl('kcode-initramfs') },
      memory_size: VM_MEMORY_BYTES,
      autostart: true,
      // Preserve the single virtio-9P device for the authorized Task 7 backend.
      filesystem: {},
    };
    if (config.useSnapshot !== false) options.initial_state = { url: this.assetUrl('alpine-state.bin.zst') };
    const emulator = new this.V86(options);
    this.emulator = emulator;
    emulator.add_listener('serial0-output-byte', (byte) => this.receiveSerialByte(byte));
  }

  /** Task 7 replaces the empty built-in 9P backend before issuing a mount. */
  async attachWorkspace(_handle: FileSystemDirectoryHandle): Promise<void> {
    if (!this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_READY');
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
    for (const listener of this.serialListeners) listener(delta);
  }
}
