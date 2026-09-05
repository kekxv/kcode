import { V86, type V86Options } from 'v86';
import { VM_MEMORY_PROFILES, type MemoryProfile, type NetworkMode } from '../types/protocol';
import { P9Server, type TransactionPolicy } from './p9/server';
import type { JournalSummary } from './p9/mutation-journal';
import { normalizeWorkspacePath } from '../utils/path';
import { toV86NetDevice } from './network-config';
import { UserVmSnapshotStore } from './user-vm-snapshot-store';

export const VM_MEMORY_BYTES = VM_MEMORY_PROFILES.standard;
export const MAX_SERIAL_DELTA_BYTES = 64 * 1024;
export const MAX_COMMAND_SERIAL_BYTES = 8 * 1024 * 1024;
export const VM_BOOT_TIMEOUT_MS = 30_000;

type V86Emulator = Pick<V86, 'add_listener' | 'serial0_send' | 'save_state' | 'destroy'>;
type V86Constructor = new (options: V86Options) => V86Emulator;
type AssetUrlResolver = (name: string) => string;
type SnapshotStore = Pick<UserVmSnapshotStore, 'load' | 'save'>;

export type V86RuntimeBootConfig = {
  /** A profile is immutable for this runtime's whole lifetime. */
  memoryProfile?: MemoryProfile;
  /** WISP is the only supported guest network backend; absence means no NIC. */
  network?: NetworkMode;
};

type V86RuntimeDependencies = {
  V86?: V86Constructor;
  assetUrl?: AssetUrlResolver;
  snapshots?: SnapshotStore;
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
  private readonly snapshots: SnapshotStore;
  private readonly hasCustomSnapshots: boolean;
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
  private bootProbeTimer: ReturnType<typeof setInterval> | null = null;
  private bootReady: { loaded: boolean; guestReady: boolean; marker: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(dependencies: V86RuntimeDependencies = {}) {
    this.V86 = dependencies.V86 ?? V86;
    this.assetUrl = dependencies.assetUrl ?? extensionAssetUrl;
    this.hasCustomSnapshots = dependencies.snapshots !== undefined;
    this.snapshots = dependencies.snapshots ?? new UserVmSnapshotStore();
    this.onOutputLimit = dependencies.onOutputLimit;
    this.readyTimeoutMs = dependencies.readyTimeoutMs ?? VM_BOOT_TIMEOUT_MS;
  }

  async boot(config: V86RuntimeBootConfig = {}): Promise<void> {
    if (this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_BOOTABLE');
    const ready = this.waitForReady();
    const memoryProfile = config.memoryProfile ?? 'standard';
    const network = config.network ?? { mode: 'offline' };
    // A state is valid only before a workspace is mounted and only with the
    // exact offline device set and RAM geometry that created it.
    const localSnapshot = network.mode === 'offline' && (this.hasCustomSnapshots || typeof indexedDB !== 'undefined')
      ? await this.snapshots.load(memoryProfile).catch(() => null)
      : null;
    const options: V86Options = {
      wasm_path: this.assetUrl('v86.wasm'),
      bios: { url: this.assetUrl('seabios.bin') },
      vga_bios: { url: this.assetUrl('vgabios.bin') },
      bzimage: { url: this.assetUrl('vmlinuz-virt') },
      initrd: { url: this.assetUrl('kcode-initramfs') },
      memory_size: VM_MEMORY_PROFILES[memoryProfile],
      autostart: true,
      cmdline: 'console=ttyS0',
      // Preserve the single virtio-9P device for the authorized Task 7 backend.
      filesystem: { handle9p: (request, reply) => {
        void this.p9Server.handle(request, reply);
      } },
    };
    if (localSnapshot) options.initial_state = { buffer: localSnapshot };
    const netDevice = toV86NetDevice(network);
    if (netDevice) options.net_device = netDevice;
    try {
      const emulator = new this.V86(options);
      this.emulator = emulator;
      emulator.add_listener('emulator-loaded', () => {
        if (this.bootReady) {
          this.bootReady.loaded = true;
          // The probe is consumed only once the cold-booted serial shell is responsive.
          this.sendBootProbe();
          this.bootProbeTimer = setInterval(() => {
            if (!this.bootReady) { if (this.bootProbeTimer) clearInterval(this.bootProbeTimer); this.bootProbeTimer = null; return; }
            this.sendBootProbe();
          }, 1_000);
          this.finishBootIfReady();
        }
      });
      emulator.add_listener('serial0-output-byte', (byte) => this.receiveSerialByte(byte));
    } catch (error) {
      this.failBoot(error instanceof Error ? error : new Error('VM_BOOT_FAILED'));
    }
    await ready;
    // First offline launch creates a browser-local acceleration state. Storage
    // failures are non-fatal: the verified assets remain a complete cold-boot path.
    if (network.mode === 'offline' && !localSnapshot && this.emulator && !this.destroyed) {
      await this.emulator.save_state().then((state) => this.snapshots.save(memoryProfile, state)).catch(() => undefined);
    }
  }

  /** Binds only the authorized directory, then mounts it only at the guest /work boundary. */
  async attachWorkspace(handle: FileSystemDirectoryHandle, workspaceBinding: string): Promise<void> {
    if (!this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_READY');
    await this.p9Server.setRoot(handle, ['read'], workspaceBinding);
    const nonce = crypto.randomUUID();
    const marker = `KCODE_MOUNT_${nonce}`;
    const mounted = this.waitForSerialMarker(marker);
    this.serialSend(`mkdir -p /work; mountpoint -q /work || mount -t 9p -o trans=virtio,version=9p2000.L,cache=none host9p /work; rc=$?; printf '${marker}:%s\\n' "$rc" >/dev/ttyS0\n`);
    await mounted;
  }

  /** The caller supplies only a transaction ID; its immutable session determines capabilities. */
  beginTransaction(transactionId: string, capabilities: TransactionPolicy['capabilities']): void {
    if (!this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_READY');
    this.p9Server.setTransactionPolicy({ transactionId, capabilities });
  }

  async commitTransaction(): Promise<void> {
    await this.p9Server.commitTransaction();
    this.p9Server.setTransactionPolicy(null);
  }

  async rollbackTransaction(): Promise<void> {
    await this.p9Server.rollbackTransaction();
    this.p9Server.setTransactionPolicy(null);
  }

  journalSummary(transactionId: string): JournalSummary { return this.p9Server.journalSummary(transactionId); }

  async readFile(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    if (!this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_READY');
    const result = await this.p9Server.readFile(normalizeWorkspacePath(path), maxBytes);
    return { text: new TextDecoder().decode(result.bytes), truncated: result.truncated };
  }

  async writeFile(path: string, content: string): Promise<{ text: string; truncated: boolean }> {
    if (!this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_READY');
    await this.p9Server.writeFile(normalizeWorkspacePath(path), new TextEncoder().encode(content));
    return { text: '', truncated: false };
  }

  serialSend(data: string): void {
    if (!this.emulator || this.destroyed) throw new Error('VM_RUNTIME_NOT_READY');
    this.emulator.serial0_send(data);
  }

  /** Execution framing owns the per-command eight MiB output budget, not boot chatter. */
  resetCommandSerialBudget(): void { this.totalSerialBytes = 0; }

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
      // The serial terminal echoes our `printf` command; accept only a real
      // marker line, never the marker text inside that echoed command.
      const marker = this.bootReady.marker;
      this.bootReady.guestReady ||= new RegExp(`(?:^|\\r?\\n)${marker}\\r?\\n`).test(this.bootSerialTail);
      this.finishBootIfReady();
    }
    for (const listener of this.serialListeners) listener(delta);
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failBoot(new Error('VM_BOOT_TIMEOUT')), this.readyTimeoutMs);
      this.bootSerialTail = '';
      this.bootReady = { loaded: false, guestReady: false, marker: `KCODE_READY_${crypto.randomUUID()}`, resolve, reject, timer };
    });
  }

  /** Mount readiness is a nonce-framed shell result, never inferred from serial timing. */
  private waitForSerialMarker(marker: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('VM_WORKSPACE_MOUNT_TIMEOUT')); }, VM_BOOT_TIMEOUT_MS);
      let buffer = '';
      const stop = this.onSerial((delta) => {
        buffer = `${buffer}${delta}`.slice(-256);
        const match = buffer.match(new RegExp(`${marker}:(\\d+)`));
        if (!match) return;
        stop(); clearTimeout(timeout);
        if (match[1] === '0') resolve(); else reject(new Error('VM_WORKSPACE_MOUNT_FAILED'));
      });
    });
  }

  private finishBootIfReady(): void {
    const ready = this.bootReady;
    if (!ready || !ready.loaded || !ready.guestReady) return;
    clearTimeout(ready.timer);
    if (this.bootProbeTimer) clearInterval(this.bootProbeTimer);
    this.bootProbeTimer = null;
    this.bootReady = null;
    ready.resolve();
  }

  private failBoot(error: Error): void {
    const ready = this.bootReady;
    if (!ready) return;
    clearTimeout(ready.timer);
    if (this.bootProbeTimer) clearInterval(this.bootProbeTimer);
    this.bootProbeTimer = null;
    this.bootReady = null;
    ready.reject(error);
  }

  private sendBootProbe(): void {
    const marker = this.bootReady?.marker;
    if (marker) this.serialSend(`printf '${marker}\\n' >/dev/ttyS0\n`);
  }
}
