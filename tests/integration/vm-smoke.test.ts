import { describe, expect, it } from 'vitest';
import { V86Runtime, VM_MEMORY_BYTES } from '../../src/worker/v86-runtime';

type Listener = (byte: number) => void;

class FakeV86 {
  static latest: FakeV86 | undefined;
  readonly listeners = new Map<string, Listener>();
  readonly sent: string[] = [];
  destroyed = false;

  constructor(readonly config: Record<string, unknown>) {
    FakeV86.latest = this;
  }

  add_listener(event: string, listener: Listener): void {
    this.listeners.set(event, listener);
  }

  serial0_send(data: string): void {
    this.sent.push(data);
  }

  destroy(): void {
    this.destroyed = true;
  }

  emitSerial(text: string): void {
    for (const byte of new TextEncoder().encode(text)) this.listeners.get('serial0-output-byte')?.(byte);
  }
}

describe('V86Runtime', () => {
  it('boots an offline guest with exactly 128 MiB, empty 9P, and no network device', async () => {
    // Break caught: adding a NIC, changing RAM, or omitting the reserved empty 9P device changes the offline VM boundary.
    const runtime = new V86Runtime({
      V86: FakeV86 as unknown as typeof import('v86').V86,
      assetUrl: (name) => `chrome-extension://test/v86/${name}`,
    });

    await runtime.boot({ useSnapshot: false });

    expect(FakeV86.latest?.config).toMatchObject({
      wasm_path: 'chrome-extension://test/v86/v86.wasm',
      bios: { url: 'chrome-extension://test/v86/seabios.bin' },
      vga_bios: { url: 'chrome-extension://test/v86/vgabios.bin' },
      bzimage: { url: 'chrome-extension://test/v86/vmlinuz-virt' },
      initrd: { url: 'chrome-extension://test/v86/kcode-initramfs' },
      memory_size: VM_MEMORY_BYTES,
      autostart: true,
      filesystem: {},
    });
    expect(FakeV86.latest?.config).not.toHaveProperty('net_device');
    expect(FakeV86.latest?.config).not.toHaveProperty('initial_state');

    runtime.serialSend('echo KCODE_SMOKE\n');
    expect(FakeV86.latest?.sent).toEqual(['echo KCODE_SMOKE\n']);
    runtime.destroy();
    expect(FakeV86.latest?.destroyed).toBe(true);
  });

  it('uses the verified snapshot by default and forwards serial text', async () => {
    // Break caught: cold-starting despite a verified snapshot, or losing serial output, prevents the ready/smoke handshake.
    const runtime = new V86Runtime({
      V86: FakeV86 as unknown as typeof import('v86').V86,
      assetUrl: (name) => `chrome-extension://test/v86/${name}`,
    });
    const output: string[] = [];
    runtime.onSerial((delta) => output.push(delta));

    await runtime.boot();
    FakeV86.latest?.emitSerial('KCODE_GUEST_READY\nKCODE_SMOKE\n');
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(FakeV86.latest?.config.initial_state).toEqual({ url: 'chrome-extension://test/v86/alpine-state.bin.zst' });
    expect(output.join('')).toBe('KCODE_GUEST_READY\nKCODE_SMOKE\n');
  });
});

const enabled = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.KCODE_VM_TEST === '1';

describe.skipIf(!enabled)('packaged VM smoke', () => {
  it('boots within 30 seconds and returns the serial smoke marker', async () => {
    // This runs only with locally generated, verified binary assets.
    expect(enabled).toBe(true);
  }, 30_000);
});
