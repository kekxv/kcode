#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDirectory = process.env.KCODE_VM_ASSETS_DIRECTORY ?? join(root, 'public', 'v86');
const manifestPath = join(assetsDirectory, 'asset-manifest.json');
const apkLockPath = join(root, 'vm', 'alpine', 'apk.lock');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const expectedNames = new Set(['v86.wasm', 'seabios.bin', 'vgabios.bin', 'vmlinuz-virt', 'kcode-initramfs', 'kcode-rootfs.sqfs', 'alpine-state.bin.zst']);
const standardRootfsLimit = 60 * 1024 * 1024;
const permittedMetadata = new Set(['README.md', 'asset-manifest.json']);
const errors = [];

const fail = (message) => errors.push(message);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  console.error(`VM asset verification failed: cannot read manifest (${error.message})`);
  process.exitCode = 1;
  process.exit();
}

if (!isRecord(manifest) || manifest.schemaVersion !== 1 || !isRecord(manifest.v86)
  || !isRecord(manifest.alpine) || !isRecord(manifest.assets) || !isRecord(manifest.snapshot)) {
  fail('manifest has an invalid schema');
} else {
  if (manifest.v86.packageVersion !== '0.5.458+gd96be77') fail('manifest v86 package version is not pinned');
  if (manifest.v86.revision !== 'd96be774e549a83371b038b86e819804c96b921f') fail('manifest v86 revision is not pinned');
  try {
    const installed = JSON.parse(await readFile(join(root, 'node_modules', 'v86', 'package.json'), 'utf8'));
    if (installed.version !== manifest.v86.packageVersion) fail(`installed v86 version differs: ${installed.version}`);
  } catch {
    fail('installed v86 package metadata is unavailable');
  }
  if (manifest.alpine.ociDigest !== 'sha256:fcc4c908760c4f561a5199f2e53576063b1b8eeaa0c41e6432d705aab4389753') {
    fail('manifest Alpine OCI digest is not pinned');
  }
  let lockDigest = '';
  try {
    lockDigest = sha256(await readFile(apkLockPath));
  } catch {
    fail('vm/alpine/apk.lock is missing');
  }
  if (!digest.test(manifest.alpine.apkLockSha256 ?? '') || manifest.alpine.apkLockSha256 !== lockDigest) {
    fail('APK lock digest is missing or mismatched');
  }
  const listedNames = Object.keys(manifest.assets);
  if (listedNames.length !== expectedNames.size || listedNames.some((name) => !expectedNames.has(name))) {
    fail('manifest asset list is incomplete or contains an unexpected asset');
  }
  for (const name of expectedNames) {
    const expectedDigest = manifest.assets[name];
    if (!digest.test(expectedDigest ?? '')) {
      fail(`${name}: expected SHA-256 is missing or invalid`);
      continue;
    }
    try {
      const details = await stat(join(assetsDirectory, name));
      if (!details.isFile()) throw new Error('not a regular file');
      if (name === 'kcode-rootfs.sqfs' && details.size > standardRootfsLimit) {
        fail(`kcode-rootfs.sqfs exceeds the standard 256 MiB boot limit (${details.size} bytes > ${standardRootfsLimit} bytes)`);
      }
      const actual = sha256(await readFile(join(assetsDirectory, name)));
      if (actual !== expectedDigest) fail(`${name}: SHA-256 mismatch (${actual})`);
    } catch {
      fail(`${name}: missing`);
    }
  }
  const assetSet = sha256(Buffer.from(JSON.stringify(
    Object.fromEntries([...expectedNames].filter((name) => name !== 'alpine-state.bin.zst').sort().map((name) => [name, manifest.assets[name]])),
  )));
  if (manifest.snapshot.v86Version !== manifest.v86.packageVersion) fail('snapshot v86 version differs from boot v86 version');
  if (!digest.test(manifest.snapshot.assetSetSha256 ?? '') || manifest.snapshot.assetSetSha256 !== assetSet) {
    fail('snapshot asset-set digest is missing or mismatched');
  }
}

try {
  for (const entry of await readdir(assetsDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      fail(`${entry.name}: non-file asset directory entry is forbidden`);
    } else if (!expectedNames.has(entry.name) && !permittedMetadata.has(entry.name)) {
      fail(`${entry.name}: unlisted file`);
    }
  }
} catch {
  fail('public/v86 cannot be enumerated');
}

if (errors.length > 0) {
  console.error('VM asset verification failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('VM asset verification passed.');
}
