#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'public', 'v86');
const manifestPath = join(assets, 'asset-manifest.json');
const snapshotPath = join(assets, 'alpine-state.bin.zst');
const baseAssets = ['v86.wasm', 'seabios.bin', 'vgabios.bin', 'vmlinuz-virt', 'kcode-initramfs', 'kcode-rootfs.sqfs'];
const protectedMarkers = ['KCODE_PROTECTED_PATH_TEST_MARKER', 'KCODE_SECRET_TEST_MARKER', 'BEGIN OPENSSH PRIVATE KEY', '/.ssh/', '/.env'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
for (const name of baseAssets) {
  const bytes = await fs.readFile(join(assets, name));
  if (hash(bytes) !== manifest.assets?.[name]) throw new Error(`${name} is missing or does not match asset-manifest.json`);
}
if (manifest.v86?.packageVersion !== '0.5.458+gd96be77') throw new Error('unexpected v86 version in manifest');

const routes = new Map([
  ['/libv86.mjs', join(root, 'node_modules', 'v86', 'build', 'libv86.mjs')],
  ...baseAssets.map((name) => [`/v86/${name}`, join(assets, name)]),
]);
const server = createServer((request, response) => {
  const requestPath = normalize(request.url?.split('?')[0] ?? '');
  if (requestPath === '/snapshot.html') {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end('<!doctype html><title>kcode snapshot builder</title>');
    return;
  }
  const target = routes.get(requestPath);
  if (!target) { response.writeHead(404).end(); return; }
  const type = extname(target) === '.mjs' ? 'text/javascript' : extname(target) === '.wasm' ? 'application/wasm' : 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  createReadStream(target).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('failed to start local snapshot server');

let browser;
try {
  browser = await chromium.launch();
  const origin = `http://127.0.0.1:${address.port}`;
  const captureFreshState = async () => {
    // A new context gives each capture a fresh module registry. The init
    // script runs before the page and, critically, before libv86 is imported.
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const RealDate = Date;
      class FixedDate extends RealDate {
        constructor(...args) {
          super(...(args.length === 0 ? [0] : args));
        }
        static now() { return 0; }
      }
      Object.defineProperty(globalThis, 'Date', { configurable: true, value: FixedDate });
      Object.defineProperty(Math, 'random', { configurable: true, value: () => 0.5 });
      let performanceTicks = 0;
      Object.defineProperty(performance, 'now', { configurable: true, value: () => performanceTicks++ });
      if (globalThis.crypto) {
        Object.defineProperty(crypto, 'getRandomValues', {
          configurable: true,
          value: (values) => {
            if (values && 'fill' in values) values.fill(0);
            return values;
          },
        });
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => '00000000-0000-4000-8000-000000000000' });
      }
    });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/snapshot.html`);
      const downloadPromise = page.waitForEvent('download');
      await page.evaluate(async ({ base, memory }) => {
        const { V86 } = await import('/libv86.mjs');
        const vm = new V86({
          wasm_path: `${base}/v86/v86.wasm`, bios: { url: `${base}/v86/seabios.bin` },
          vga_bios: { url: `${base}/v86/vgabios.bin` }, bzimage: { url: `${base}/v86/vmlinuz-virt` },
          initrd: { url: `${base}/v86/kcode-initramfs` }, cmdline: 'console=ttyS0',
          memory_size: memory, autostart: true, disable_jit: true, filesystem: {},
        });
        let saved;
        await new Promise((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error(`KCODE_GUEST_READY timeout; serial tail: ${output}`)), 30_000);
          vm.add_listener('serial0-output-byte', (byte) => {
            output += String.fromCharCode(byte);
            if (!saved && output.includes('KCODE_GUEST_READY')) {
              saved = vm.save_state();
              clearTimeout(timer);
              resolve();
            }
            if (output.length > 8192) output = output.slice(-8192);
          });
        });
        if (!saved) throw new Error('KCODE_GUEST_READY did not produce a snapshot state');
        const state = await saved;
        await vm.destroy();
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(new Blob([state]));
        anchor.download = 'alpine-state.bin';
        anchor.click();
      }, { base: origin, memory: 256 * 1024 * 1024 });
      const download = await downloadPromise;
      const downloadedPath = await download.path();
      if (!downloadedPath) throw new Error('snapshot state download did not complete');
      return await fs.readFile(downloadedPath);
    } finally {
      await context.close();
    }
  };
  const first = await captureFreshState();
  const second = await captureFreshState();
  if (first.length !== second.length || first.some((byte, index) => byte !== second[index])) {
    const offset = first.findIndex((byte, index) => byte !== second[index]);
    throw new Error(`two fresh snapshots differ at byte ${offset} (${first.length} bytes vs ${second.length} bytes); refusing non-reproducible output`);
  }
  const raw = first;
  for (const marker of protectedMarkers) {
    const markerOffset = Buffer.from(raw).indexOf(Buffer.from(marker));
    if (markerOffset >= 0) throw new Error(`snapshot contains protected marker: ${marker} at byte ${markerOffset}`);
  }
  const temporary = `${snapshotPath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, zstdCompressSync(raw));
  await fs.rename(temporary, snapshotPath);
  manifest.assets['alpine-state.bin.zst'] = hash(await fs.readFile(snapshotPath));
  manifest.snapshot.v86Version = manifest.v86.packageVersion;
  manifest.snapshot.assetSetSha256 = hash(Buffer.from(JSON.stringify(
    Object.fromEntries(baseAssets.sort().map((name) => [name, manifest.assets[name]])),
  )));
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('Created verified Alpine v86 snapshot.');
