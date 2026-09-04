import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build as viteBuild } from 'vite';
import { describe, expect, it } from 'vitest';
import { V86Runtime, VM_MEMORY_BYTES } from '../../src/worker/v86-runtime';

type Listener = (byte: number) => void;

const execFile = promisify(execFileCallback);
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const standardRootfsLimit = 60 * 1024 * 1024;
const initramfsWireLimit = 64 * 1024 * 1024;

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
  it('boots an offline guest with exactly 256 MiB, empty 9P, and no network device', async () => {
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
      memory_size: 256 * 1024 * 1024,
      autostart: true,
      disable_jit: true,
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

describe('two-stage Alpine boot assets', () => {
  it('lists the embedded SquashFS root image in the manifest', async () => {
    // Break caught: omitting the separately verified root image makes the loader's embedded payload unverifiable.
    const manifest = JSON.parse(await fs.readFile(join(root, 'public/v86/asset-manifest.json'), 'utf8'));
    expect(manifest.assets).toHaveProperty('kcode-rootfs.sqfs');
  });

  it('rejects a standard-profile root image larger than the boot payload limit', async () => {
    // Break caught: accepting a root image larger than v86's standard 256 MiB boot window makes cold boot fail before /init runs.
    const fixture = await fs.mkdtemp(join(tmpdir(), 'kcode-vm-assets-'));
    try {
      const assets = join(fixture, 'assets');
      await fs.mkdir(assets);
      for (const name of ['v86.wasm', 'seabios.bin', 'vgabios.bin', 'vmlinuz-virt', 'kcode-initramfs']) {
        await fs.copyFile(join(root, 'public/v86', name), join(assets, name));
      }
      const rootfs = join(assets, 'kcode-rootfs.sqfs');
      await fs.writeFile(rootfs, Buffer.alloc(1));
      await fs.truncate(rootfs, standardRootfsLimit + 1);
      await fs.writeFile(join(assets, 'alpine-state.bin.zst'), 'state');

      const source = JSON.parse(await fs.readFile(join(root, 'public/v86/asset-manifest.json'), 'utf8'));
      const assetNames = ['v86.wasm', 'seabios.bin', 'vgabios.bin', 'vmlinuz-virt', 'kcode-initramfs', 'kcode-rootfs.sqfs', 'alpine-state.bin.zst'];
      source.assets = Object.fromEntries(await Promise.all(assetNames.map(async (name) => [
        name,
        sha256(await fs.readFile(join(assets, name))),
      ])));
      source.snapshot = {
        v86Version: source.v86.packageVersion,
        assetSetSha256: sha256(Buffer.from(JSON.stringify(Object.fromEntries(
          assetNames.filter((name) => name !== 'alpine-state.bin.zst').sort().map((name) => [name, source.assets[name]]),
        )))),
      };
      await fs.writeFile(join(assets, 'asset-manifest.json'), `${JSON.stringify(source)}\n`);

      await expect(execFile('node', ['scripts/verify-vm-assets.mjs'], {
        cwd: root,
        env: { ...process.env, KCODE_VM_ASSETS_DIRECTORY: assets },
      })).rejects.toMatchObject({ stderr: expect.stringContaining('kcode-rootfs.sqfs exceeds the standard 256 MiB boot limit') });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects an initramfs larger than v86\'s 64 MiB on-wire window', async () => {
    // Break caught: allowing an oversized compressed initrd lets v86 fail before the embedded loader can run.
    const fixture = await fs.mkdtemp(join(tmpdir(), 'kcode-vm-assets-'));
    try {
      const assets = join(fixture, 'assets');
      await fs.mkdir(assets);
      const source = JSON.parse(await fs.readFile(join(root, 'public/v86/asset-manifest.json'), 'utf8'));
      const assetNames = Object.keys(source.assets);
      await Promise.all(assetNames.map((name) => fs.copyFile(join(root, 'public/v86', name), join(assets, name))));
      await fs.truncate(join(assets, 'kcode-initramfs'), initramfsWireLimit + 1);
      source.assets = Object.fromEntries(await Promise.all(assetNames.map(async (name) => [
        name,
        sha256(await fs.readFile(join(assets, name))),
      ])));
      source.snapshot.assetSetSha256 = sha256(Buffer.from(JSON.stringify(Object.fromEntries(
        assetNames.filter((name) => name !== 'alpine-state.bin.zst').sort().map((name) => [name, source.assets[name]]),
      ))));
      await fs.writeFile(join(assets, 'asset-manifest.json'), `${JSON.stringify(source)}\n`);

      await expect(execFile('node', ['scripts/verify-vm-assets.mjs'], {
        cwd: root,
        env: { ...process.env, KCODE_VM_ASSETS_DIRECTORY: assets },
      })).rejects.toMatchObject({ stderr: expect.stringContaining('kcode-initramfs exceeds the v86 64 MiB on-wire limit') });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects an initramfs whose embedded root image differs from the manifest-bound loose asset', async () => {
    // Break caught: accepting a separately hashed root image that is not the bytes embedded in /kcode-initramfs defeats boot-time asset verification.
    const fixture = await fs.mkdtemp(join(tmpdir(), 'kcode-vm-assets-'));
    try {
      const assets = join(fixture, 'assets');
      await fs.mkdir(assets);
      const source = JSON.parse(await fs.readFile(join(root, 'public/v86/asset-manifest.json'), 'utf8'));
      const assetNames = Object.keys(source.assets);
      await Promise.all(assetNames.map((name) => fs.copyFile(join(root, 'public/v86', name), join(assets, name))));
      await fs.writeFile(join(assets, 'kcode-rootfs.sqfs'), 'different root image');
      source.assets = Object.fromEntries(await Promise.all(assetNames.map(async (name) => [
        name,
        sha256(await fs.readFile(join(assets, name))),
      ])));
      source.snapshot.assetSetSha256 = sha256(Buffer.from(JSON.stringify(Object.fromEntries(
        assetNames.filter((name) => name !== 'alpine-state.bin.zst').sort().map((name) => [name, source.assets[name]]),
      ))));
      await fs.writeFile(join(assets, 'asset-manifest.json'), `${JSON.stringify(source)}\n`);

      await expect(execFile('node', ['scripts/verify-vm-assets.mjs'], {
        cwd: root,
        env: { ...process.env, KCODE_VM_ASSETS_DIRECTORY: assets },
      })).rejects.toMatchObject({ stderr: expect.stringContaining('embedded /kcode-rootfs.sqfs SHA-256 differs') });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects a protected marker in a rootfs symlink target', async () => {
    // Break caught: scanning only file bytes permits a protected path to survive packaging through a symlink target.
    const rootfs = await fs.mkdtemp(join(tmpdir(), 'kcode-rootfs-marker-'));
    try {
      await fs.symlink('.env', join(rootfs, 'escaped-marker'));
      await expect(execFile('node', ['scripts/scan-vm-image.mjs', rootfs], { cwd: root }))
        .rejects.toMatchObject({ stderr: expect.stringContaining('rootfs symlink target contains protected marker: /.env') });
    } finally {
      await fs.rm(rootfs, { recursive: true, force: true });
    }
  });

  it('mounts the embedded root image read-only as SquashFS before switching root', async () => {
    // Break caught: an initrd that switches root without a read-only SquashFS mount cannot expose the embedded Alpine root.
    const extracted = await fs.mkdtemp(join(tmpdir(), 'kcode-initramfs-'));
    try {
      await execFile('bash', ['-c', 'xz -dc -- "$1" | cpio -idmu --quiet', 'bash', join(root, 'public/v86/kcode-initramfs')], {
        cwd: extracted,
      });
      const loader = await fs.readFile(join(extracted, 'init'), 'utf8');
      expect(loader).toMatch(/mount\s+-t\s+squashfs\s+-o\s+ro\s+\/dev\/loop0\s+\/newroot/);
      expect(loader.indexOf('mount -t squashfs')).toBeLessThan(loader.indexOf('switch_root /newroot /sbin/init'));
      expect(loader).toContain('mount --move /dev /newroot/dev');
      expect(loader.indexOf('mount --move /dev /newroot/dev')).toBeLessThan(loader.indexOf('switch_root /newroot /sbin/init'));
    } finally {
      await fs.rm(extracted, { recursive: true, force: true });
    }
  });

  it('exposes every loader command through the embedded BusyBox binary', async () => {
    // Break caught: a loader script can be present but still panic as PID 1 when its BusyBox applet names are absent.
    const extracted = await fs.mkdtemp(join(tmpdir(), 'kcode-initramfs-'));
    try {
      await execFile('bash', ['-c', 'xz -dc -- "$1" | cpio -idmu --quiet', 'bash', join(root, 'public/v86/kcode-initramfs')], {
        cwd: extracted,
      });
      for (const command of ['mount', 'modprobe', 'losetup', 'switch_root']) {
        expect(await fs.readlink(join(extracted, 'bin', command))).toBe('busybox');
      }
    } finally {
      await fs.rm(extracted, { recursive: true, force: true });
    }
  });
});

const enabled = process.env.KCODE_VM_TEST === '1';

describe.skipIf(!enabled)('packaged VM smoke', () => {
  it('boots the production Worker and runtime snapshot within 30 seconds and returns the serial smoke marker', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    for (const name of ['v86.wasm', 'seabios.bin', 'vgabios.bin', 'vmlinuz-virt', 'kcode-initramfs', 'alpine-state.bin.zst']) {
      await fs.access(join(root, 'public/v86', name));
    }
    await viteBuild({ root, configFile: join(root, 'vite.config.ts') });
    const workerFile = (await fs.readdir(join(root, 'dist/assets'))).find((name) => /^vm\.worker-.*\.js$/.test(name));
    if (!workerFile) throw new Error('PACKAGED_VM_WORKER_MISSING');
    const userDataDirectory = await fs.mkdtemp(join(tmpdir(), 'kcode-vm-smoke-'));
    const browser = await chromium.launchPersistentContext(userDataDirectory, {
      headless: false,
      args: [`--disable-extensions-except=${join(root, 'dist')}`, `--load-extension=${join(root, 'dist')}`],
    });
    try {
      const serviceWorker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
      const extensionOrigin = serviceWorker.url().match(/^(chrome-extension:\/\/[^/]+)/)?.[1];
      if (!extensionOrigin) throw new Error('PACKAGED_VM_EXTENSION_ORIGIN_MISSING');
      const page = await browser.newPage();
      await page.goto(`${extensionOrigin}/src/sidepanel/index.html`);
      await expect(page.evaluate(async ({ workerFile, memory }) => {
        return new Promise<string>((resolve, reject) => {
          const worker = new Worker(chrome.runtime.getURL(`assets/${workerFile}`), { type: 'module' });
          const timer = setTimeout(() => reject(new Error('worker VM_READY timeout')), 30_000);
          let ready = false;
          worker.onmessage = ({ data }) => {
            if (data?.kind === 'VM_READY' && !ready) {
              ready = true;
              worker.postMessage({ kind: 'VM_EXEC', requestId: 'worker-smoke', command: 'echo KCODE_SMOKE', timeoutMs: 30_000 });
              return;
            }
            if (ready && data?.kind === 'VM_OUTPUT_DELTA' && data.requestId === 'worker-smoke' && data.delta.includes('KCODE_SMOKE')) {
              clearTimeout(timer);
              worker.terminate();
              resolve(data.delta);
            }
            if (data?.kind === 'VM_ERROR') { clearTimeout(timer); reject(new Error(data.code)); }
          };
          worker.postMessage({ kind: 'VM_INIT', requestId: 'worker-boot', session: { mode: 'workspace', capabilities: ['read'], network: { mode: 'offline' } } });
        });
      }, { workerFile, memory: VM_MEMORY_BYTES })).resolves.toContain('KCODE_SMOKE');
    } finally {
      await browser.close();
      await fs.rm(userDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
