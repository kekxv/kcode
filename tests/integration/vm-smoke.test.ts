import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
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
});

const enabled = process.env.KCODE_VM_TEST === '1';

describe.skipIf(!enabled)('packaged VM smoke', () => {
  it('boots within 30 seconds and returns the serial smoke marker', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const assets = join(root, 'public/v86');
    const routes = new Map<string, string | null>([
      ['/smoke.html', null],
      ['/libv86.mjs', join(root, 'node_modules/v86/build/libv86.mjs')],
      ...['v86.wasm', 'seabios.bin', 'vgabios.bin', 'vmlinuz-virt', 'kcode-initramfs'].map((name): [string, string] => [`/v86/${name}`, join(assets, name)]),
    ]);
    for (const path of routes.values()) if (path) await fs.access(path);
    const server = createServer((request, response) => {
      const requestPath = request.url?.split('?')[0] ?? '';
      if (requestPath === '/smoke.html') {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>kcode VM smoke</title>');
        return;
      }
      const path = routes.get(requestPath);
      if (!path) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': extname(path) === '.mjs' ? 'text/javascript' : extname(path) === '.wasm' ? 'application/wasm' : 'application/octet-stream' });
      createReadStream(path).pipe(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SMOKE_SERVER_FAILED');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${address.port}`;
      await page.goto(`${origin}/smoke.html`);
      await expect(page.evaluate(async ({ origin: base, memory }) => {
        const modulePath = '/libv86.mjs';
        const { V86 } = await import(modulePath) as typeof import('v86');
        return new Promise<string>((resolve, reject) => {
          const config = {
            wasm_path: `${base}/v86/v86.wasm`, bios: { url: `${base}/v86/seabios.bin` },
            vga_bios: { url: `${base}/v86/vgabios.bin` }, bzimage: { url: `${base}/v86/vmlinuz-virt` },
            initrd: { url: `${base}/v86/kcode-initramfs` }, cmdline: 'console=ttyS0',
            memory_size: memory, autostart: true, filesystem: {},
          };
          if (config.memory_size !== 128 * 1024 * 1024 || 'net_device' in config) reject(new Error('unsafe VM smoke config'));
          const vm = new V86(config);
          let output = '';
          let sentSmoke = false;
          const timer = setTimeout(() => reject(new Error('KCODE_GUEST_READY timeout')), 30_000);
          vm.add_listener('serial0-output-byte', (byte: number) => {
            output += String.fromCharCode(byte);
            if (!sentSmoke && output.includes('KCODE_GUEST_READY')) {
              sentSmoke = true;
              vm.serial0_send('echo KCODE_SMOKE\n');
            }
            if (output.includes('KCODE_SMOKE')) { clearTimeout(timer); void vm.destroy(); resolve(output); }
            if (output.length > 65_536) output = output.slice(-65_536);
          });
        });
      }, { origin, memory: VM_MEMORY_BYTES })).resolves.toContain('KCODE_SMOKE');
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);
});
