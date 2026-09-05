#!/usr/bin/env node
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';

const [rootfs] = process.argv.slice(2);
if (!rootfs) throw new Error('usage: scan-vm-image.mjs ROOTFS_DIRECTORY');

const markers = ['KCODE_PROTECTED_PATH_TEST_MARKER', 'KCODE_SECRET_TEST_MARKER', 'BEGIN OPENSSH PRIVATE KEY', '/.ssh/', '/.env'];
const markerBytes = markers.map((marker) => [marker, Buffer.from(marker)]);
const protectedPath = (imagePath) => imagePath.includes('/.ssh/') || imagePath.endsWith('/.ssh') || imagePath.endsWith('/.env');
const protectedTargetMarker = (target) => {
  for (const marker of markers) if (target.includes(marker)) return marker;
  if (target === '.env' || target.endsWith('/.env')) return '/.env';
  if (target === '.ssh' || target.startsWith('.ssh/') || target.endsWith('/.ssh') || target.includes('/.ssh/')) return '/.ssh/';
  return undefined;
};

const scan = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const imagePath = `/${relative(rootfs, path)}`;
    if (protectedPath(imagePath)) throw new Error(`rootfs contains protected path: ${imagePath}`);
    const details = await lstat(path);
    if (details.isDirectory()) {
      await scan(path);
    } else if (details.isSymbolicLink()) {
      const target = await readlink(path);
      const marker = protectedTargetMarker(target);
      if (marker) throw new Error(`rootfs symlink target contains protected marker: ${marker}`);
    } else if (details.isFile()) {
      const bytes = await readFile(path);
      for (const [marker, markerBytesValue] of markerBytes) {
        if (bytes.includes(markerBytesValue)) throw new Error(`rootfs contains protected marker: ${marker}`);
      }
    }
  }
};

try {
  await scan(rootfs);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
