#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDirectory = process.env.KCODE_VM_ASSETS_DIRECTORY ?? join(root, 'public', 'v86');
const manifestPath = join(assetsDirectory, 'asset-manifest.json');
const apkLockPath = join(root, 'vm', 'alpine', 'apk.lock');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const expectedNames = new Set(['v86.wasm', 'seabios.bin', 'vgabios.bin', 'vmlinuz-virt', 'kcode-initramfs']);
const standardRootfsLimit = 60 * 1024 * 1024;
const initramfsWireLimit = 64 * 1024 * 1024;
const toolchainImage = 'kcode-alpine-i386:locked';
const permittedMetadata = new Set(['README.md', 'asset-manifest.json']);
const deepVerification = process.argv.includes('--deep') || process.env.KCODE_VM_DEEP_VERIFY === '1';
const errors = [];
const execFile = promisify(execFileCallback);
const containerUser = typeof process.getuid === 'function' && typeof process.getgid === 'function'
  ? `${process.getuid()}:${process.getgid()}`
  : undefined;

const fail = (message) => errors.push(message);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

let toolchainReady;
const ensureToolchain = async () => {
  toolchainReady ??= execFile('docker', [
    'build', '--platform', 'linux/386', '--pull=false', '--tag', toolchainImage,
    '--file', join(root, 'vm', 'alpine', 'Dockerfile'), root,
  ]);
  await toolchainReady;
};

const inspectEmbeddedRootfs = async (initramfsPath) => {
  const staging = await mkdtemp(join(root, '.verify-initramfs-'));
  const extraction = join(staging, 'output');
  try {
    await mkdir(extraction);
    await copyFile(initramfsPath, join(staging, 'kcode-initramfs'));
    await ensureToolchain();
    await execFile('docker', [
      'run', '--rm', '--platform', 'linux/386',
      ...(containerUser ? ['--user', containerUser] : []),
      '--mount', `type=bind,src=${staging},dst=/input,readonly`,
      '--mount', `type=bind,src=${extraction},dst=/output`,
      toolchainImage,
      'sh', '-ec', 'cd /output && xz -dc /input/kcode-initramfs | cpio -idm',
    ]);
    const embeddedRootfs = join(extraction, 'kcode-rootfs.sqfs');
    const details = await stat(embeddedRootfs);
    if (!details.isFile()) throw new Error('embedded kcode-rootfs.sqfs is not a regular file');
    if (details.size > standardRootfsLimit) throw new Error(`embedded kcode-rootfs.sqfs exceeds the standard 256 MiB boot limit (${details.size} bytes > ${standardRootfsLimit} bytes)`);
    await execFile('docker', [
      'run', '--rm', '--platform', 'linux/386',
      '--mount', `type=bind,src=${extraction},dst=/input,readonly`,
      '--mount', `type=bind,src=${join(root, 'scripts')},dst=/scripts,readonly`,
      toolchainImage,
      'sh', '-ec', 'mkdir -p /tmp/kcode-rootfs && unsquashfs -no-progress -d /tmp/kcode-rootfs /input/kcode-rootfs.sqfs >/dev/null && node /scripts/scan-vm-image.mjs /tmp/kcode-rootfs',
    ]);
    return sha256(await readFile(embeddedRootfs));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  console.error(`VM asset verification failed: cannot read manifest (${error.message})`);
  process.exitCode = 1;
  process.exit();
}

if (!isRecord(manifest) || manifest.schemaVersion !== 1 || !isRecord(manifest.v86)
  || !isRecord(manifest.alpine) || !isRecord(manifest.assets)) {
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
  let initramfsCanBeInspected = true;
  for (const name of expectedNames) {
    const expectedDigest = manifest.assets[name];
    if (!digest.test(expectedDigest ?? '')) {
      fail(`${name}: expected SHA-256 is missing or invalid`);
      continue;
    }
    try {
      const details = await stat(join(assetsDirectory, name));
      if (!details.isFile()) throw new Error('not a regular file');
      if (name === 'kcode-initramfs' && details.size > initramfsWireLimit) {
        fail(`kcode-initramfs exceeds the v86 64 MiB on-wire limit (${details.size} bytes > ${initramfsWireLimit} bytes)`);
        initramfsCanBeInspected = false;
      }
      const actual = sha256(await readFile(join(assetsDirectory, name)));
      if (actual !== expectedDigest) fail(`${name}: SHA-256 mismatch (${actual})`);
      if (name === 'kcode-initramfs' && actual !== expectedDigest) initramfsCanBeInspected = false;
    } catch {
      fail(`${name}: missing`);
      if (name === 'kcode-initramfs') initramfsCanBeInspected = false;
    }
  }
  if (deepVerification && initramfsCanBeInspected) {
    try {
      await inspectEmbeddedRootfs(join(assetsDirectory, 'kcode-initramfs'));
    } catch (error) {
      fail(`cannot inspect embedded /kcode-rootfs.sqfs (${error instanceof Error ? error.message : String(error)})`);
    }
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
