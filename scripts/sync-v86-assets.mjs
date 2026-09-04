#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetDirectory = join(root, 'public', 'v86');
const revision = 'd96be774e549a83371b038b86e819804c96b921f';
const expected = {
  'v86.wasm': '6121632f6d657d03f2286341ed87edcafd4945fa65ae765b4c7fd0bf2554a9c7',
  'seabios.bin': '73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98',
  'vgabios.bin': 'a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880',
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function installVerified(name, source) {
  const destination = join(assetDirectory, name);
  const temporary = `${destination}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  try {
    const bytes = await source();
    const actual = sha256(bytes);
    if (actual !== expected[name]) throw new Error(`${name}: SHA-256 mismatch (${actual})`);
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function download(name) {
  const response = await fetch(`https://raw.githubusercontent.com/copy/v86/${revision}/bios/${name}`, { redirect: 'error' });
  if (!response.ok) throw new Error(`${name}: download failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

await mkdir(assetDirectory, { recursive: true });
await installVerified('v86.wasm', async () => readFile(join(root, 'node_modules', 'v86', 'build', 'v86.wasm')));
await installVerified('seabios.bin', () => download('seabios.bin'));
await installVerified('vgabios.bin', () => download('vgabios.bin'));
console.log('Verified v86 wasm and BIOS assets were synchronized.');
