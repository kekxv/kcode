#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'public', 'v86');
const manifestPath = join(assets, 'asset-manifest.json');
const snapshotPath = join(assets, 'alpine-state.bin.zst');
const baseAssets = ['v86.wasm', 'seabios.bin', 'vgabios.bin', 'vmlinuz-virt', 'kcode-initramfs'];
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
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${address.port}`;
  await page.goto(`${origin}/snapshot.html`);
  const state = await page.evaluate(async ({ base, memory }) => {
    // v86 consults host time/randomness while constructing a machine. Freeze
    // the JavaScript sources it can observe, then reject any byte drift below.
    Date.now = () => 0;
    Math.random = () => 0.5;
    const { V86 } = await import('/libv86.mjs');
    const vm = new V86({
      wasm_path: `${base}/v86/v86.wasm`, bios: { url: `${base}/v86/seabios.bin` },
      vga_bios: { url: `${base}/v86/vgabios.bin` }, bzimage: { url: `${base}/v86/vmlinuz-virt` },
      initrd: { url: `${base}/v86/kcode-initramfs` }, cmdline: 'console=ttyS0',
      memory_size: memory, autostart: true, filesystem: {},
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('KCODE_GUEST_READY timeout')), 30_000);
      vm.add_listener('serial0-output-byte', (byte) => {
        if (byte === 0x0a) return;
      });
      vm.add_listener('serial0-output-byte', (() => {
        let output = '';
        return (byte) => {
          output += String.fromCharCode(byte);
          if (output.includes('KCODE_GUEST_READY')) { clearTimeout(timer); resolve(); }
          if (output.length > 1024) output = output.slice(-1024);
        };
      })());
    });
    const saved = await vm.save_state();
    await vm.destroy();
    return Array.from(new Uint8Array(saved));
  }, { base: origin, memory: 128 * 1024 * 1024 });
  const raw = Uint8Array.from(state);
  for (const marker of protectedMarkers) {
    if (Buffer.from(raw).includes(Buffer.from(marker))) throw new Error(`snapshot contains protected marker: ${marker}`);
  }
  try {
    const existing = zstdDecompressSync(await fs.readFile(snapshotPath));
    if (!existing.equals(raw)) throw new Error('snapshot bytes differ from the prior verified build');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
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
