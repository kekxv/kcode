import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
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

  emit(event: string): void {
    this.listeners.get(event)?.(0);
  }

  emitSerial(text: string): void {
    for (const byte of new TextEncoder().encode(text)) this.listeners.get('serial0-output-byte')?.(byte);
  }

  emitBytes(bytes: Uint8Array): void {
    for (const byte of bytes) this.listeners.get('serial0-output-byte')?.(byte);
  }
}

describe('V86Runtime', () => {
  it('boots an offline guest with exactly 128 MiB, empty 9P, and no network device', async () => {
    // Break caught: adding a NIC, changing RAM, or omitting the reserved empty 9P device changes the offline VM boundary.
    const runtime = new V86Runtime({
      V86: FakeV86 as unknown as typeof import('v86').V86,
      assetUrl: (name) => `chrome-extension://test/v86/${name}`,
    });

    let settled = false;
    const boot = runtime.boot({ useSnapshot: false }).then(() => { settled = true; });
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(settled).toBe(false);
    FakeV86.latest?.emit('emulator-loaded');
    expect(FakeV86.latest?.sent).toContain("printf 'KCODE_GUEST_READY\\n' >/dev/ttyS0\n");
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(settled).toBe(false);
    FakeV86.latest?.emitSerial('KCODE_GUEST_READY\n');
    await boot;

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
    expect(FakeV86.latest?.sent).toContain('echo KCODE_SMOKE\n');
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

    const boot = runtime.boot();
    FakeV86.latest?.emit('emulator-loaded');
    FakeV86.latest?.emitSerial('KCODE_GUEST_READY\nKCODE_SMOKE\n');
    await boot;
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(FakeV86.latest?.config.initial_state).toEqual({ url: 'chrome-extension://test/v86/alpine-state.bin.zst' });
    expect(output.join('')).toBe('KCODE_GUEST_READY\nKCODE_SMOKE\n');
  });

  it('splits invalid serial bytes by encoded UTF-8 payload size', async () => {
    // Break caught: a raw 64 KiB batch of invalid bytes expands to 192 KiB of U+FFFD text and must not cross the Worker event limit.
    const runtime = new V86Runtime({
      V86: FakeV86 as unknown as typeof import('v86').V86,
      assetUrl: (name) => `chrome-extension://test/v86/${name}`,
    });
    const deltas: string[] = [];
    runtime.onSerial((delta) => deltas.push(delta));
    const boot = runtime.boot({ useSnapshot: false });
    FakeV86.latest?.emit('emulator-loaded');
    FakeV86.latest?.emitSerial('KCODE_GUEST_READY\n');
    await boot;
    deltas.length = 0;

    FakeV86.latest?.emitBytes(new Uint8Array(64 * 1024).fill(0xff));
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(deltas).toHaveLength(4);
    expect(deltas.every((delta) => new TextEncoder().encode(delta).byteLength <= 64 * 1024)).toBe(true);
    expect(deltas.join('')).toBe('\uFFFD'.repeat(64 * 1024));
  });
});

const enabled = process.env.KCODE_VM_TEST === '1';

describe.skipIf(!enabled)('packaged VM smoke', () => {
  it('boots the production Worker and runtime snapshot within 30 seconds and returns the serial smoke marker', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    for (const name of ['v86.wasm', 'seabios.bin', 'vgabios.bin', 'vmlinuz-virt', 'kcode-initramfs', 'alpine-state.bin.zst']) {
      await fs.access(join(root, 'public/v86', name));
    }
    const vite = await createViteServer({
      root,
      configFile: false,
      optimizeDeps: { exclude: ['v86'] },
      plugins: [{
        name: 'kcode-vm-smoke-worker',
        configureServer(server) {
          server.middlewares.use('/smoke-worker.mjs', (_request, response) => {
            response.setHeader('Content-Type', 'text/javascript');
            response.end("self.chrome = { runtime: { getURL: (path) => new URL(path, self.location.origin + '/').href } }; import '/src/worker/vm.worker.ts';");
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    });
    await vite.listen();
    const origin = vite.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (!origin) throw new Error('SMOKE_SERVER_FAILED');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      await expect(page.evaluate(async ({ base, memory }) => {
        (globalThis as unknown as { chrome: unknown }).chrome = {
          runtime: { getURL: (path: string) => new URL(path, `${base}/`).href },
        };
        await new Promise<void>((resolve, reject) => {
          const worker = new Worker(`${base}/smoke-worker.mjs`, { type: 'module' });
          const timer = setTimeout(() => reject(new Error('worker VM_READY timeout')), 30_000);
          worker.onmessage = ({ data }) => {
            if (data?.kind === 'VM_READY') { clearTimeout(timer); worker.terminate(); resolve(); }
            if (data?.kind === 'VM_ERROR') { clearTimeout(timer); reject(new Error(data.code)); }
          };
          worker.postMessage({ kind: 'VM_INIT', requestId: 'worker-boot', session: { mode: 'workspace', capabilities: ['read'], network: { mode: 'offline' } } });
        });
        const modulePath = '/src/worker/v86-runtime.ts';
        const { V86Runtime } = await import(modulePath) as typeof import('../../src/worker/v86-runtime');
        const runtime = new V86Runtime();
        const configMemory = memory;
        if (configMemory !== 128 * 1024 * 1024) throw new Error('unsafe VM memory');
        const output: string[] = [];
        runtime.onSerial((delta) => output.push(delta));
        await runtime.boot();
        runtime.serialSend('echo KCODE_SMOKE\n');
        await new Promise<void>((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error('KCODE_SMOKE timeout')), 30_000);
          const stop = runtime.onSerial((delta) => {
            output += delta;
            if (output.includes('KCODE_SMOKE')) { clearTimeout(timer); stop(); resolve(); }
            if (output.length > 65_536) output = output.slice(-65_536);
          });
        });
        runtime.destroy();
        if (!output.join('').includes('KCODE_SMOKE')) throw new Error('serial smoke marker missing');
        return output.join('');
      }, { base: origin, memory: VM_MEMORY_BYTES })).resolves.toContain('KCODE_SMOKE');
    } finally {
      await browser.close();
      await vite.close();
    }
  }, 60_000);
});
