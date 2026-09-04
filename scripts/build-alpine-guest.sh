#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image='kcode-alpine-i386:locked'
container=''
staging=$(mktemp -d)
cleanup() {
  [[ -n "$container" ]] && docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$staging"
}
trap cleanup EXIT

for command in docker cpio sha256sum node; do command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }; done

docker build --platform linux/386 --pull=false --tag "$image" --file "$root/vm/alpine/Dockerfile" "$root"
container=$(docker create "$image")
docker cp "$container:/usr/local/share/kcode/apk.lock" "$staging/apk.lock"
if ! cmp -s "$root/vm/alpine/apk.lock" "$staging/apk.lock"; then
  if [[ "${KCODE_UPDATE_APK_LOCK:-}" == '1' ]]; then
    install -m 0644 "$staging/apk.lock" "$root/vm/alpine/apk.lock"
  else
  echo 'APK lock drift detected; inspect the pinned image/package repository before updating vm/alpine/apk.lock.' >&2
  diff -u "$root/vm/alpine/apk.lock" "$staging/apk.lock" >&2 || true
  exit 1
  fi
fi

mkdir "$staging/rootfs"
docker export "$container" | (cd "$staging/rootfs" && cpio -idm --quiet)
rm -f "$staging/rootfs/.dockerenv" "$staging/rootfs/root/.ash_history" "$staging/rootfs/etc/machine-id"
rm -rf "$staging/rootfs/tmp"/* "$staging/rootfs/var/cache/apk"/* "$staging/rootfs/var/log"/*
rm -rf "$staging/rootfs/var/lib/dhcp" "$staging/rootfs/var/lib/NetworkManager" "$staging/rootfs/etc/ssh/ssh_host_"*
find "$staging/rootfs" -xdev \( -name '*.log' -o -name 'build.log' \) -type f -delete

test -f "$staging/rootfs/boot/vmlinuz-virt"
cp "$staging/rootfs/boot/vmlinuz-virt" "$root/public/v86/vmlinuz-virt"
( cd "$staging/rootfs" && find . -xdev -print0 | LC_ALL=C sort -z | xargs -0 touch -h -d '@0' )
( cd "$staging/rootfs" && find . -xdev -print0 | LC_ALL=C sort -z | cpio --null -o -H newc --owner 0:0 --reproducible ) > "$root/public/v86/kcode-initramfs"

node --input-type=module - "$root/public/v86/asset-manifest.json" "$root/vm/alpine/apk.lock" <<'NODE'
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const [manifestPath, lockPath] = process.argv.slice(2);
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.alpine.apkLockSha256 = await hash(lockPath);
manifest.assets['vmlinuz-virt'] = await hash(new URL('./vmlinuz-virt', `file://${manifestPath}`).pathname);
manifest.assets['kcode-initramfs'] = await hash(new URL('./kcode-initramfs', `file://${manifestPath}`).pathname);
manifest.assets['alpine-state.bin.zst'] = null;
manifest.snapshot.assetSetSha256 = null;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

echo 'Generated reproducible vmlinuz-virt and kcode-initramfs; build the snapshot next.'
