#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image='kcode-alpine-i386:locked'
container=''
staging=$(mktemp -d "$root/.build-alpine-guest.XXXXXX")
rootfs_limit=$((60 * 1024 * 1024))
initramfs_wire_limit=$((64 * 1024 * 1024))
cleanup() {
  [[ -n "$container" ]] && docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$staging"
}
trap cleanup EXIT

for command in docker sha256sum node tar; do command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }; done

docker build --platform linux/386 --pull=false --tag "$image" --file "$root/vm/alpine/Dockerfile" "$root"
container=$(docker create "$image")
docker cp "$container:/usr/local/share/kcode/apk.lock" "$staging/apk.lock"
if ! cmp -s "$root/vm/alpine/apk.lock" "$staging/apk.lock"; then
  echo 'APK lock drift detected; inspect the pinned image/package repository before updating vm/alpine/apk.lock.' >&2
  diff -u "$root/vm/alpine/apk.lock" "$staging/apk.lock" >&2 || true
  exit 1
fi

mkdir "$staging/rootfs" "$staging/loader" "$staging/output"
docker export "$container" | tar -xf - -C "$staging/rootfs"
mkdir -p "$staging/rootfs/work"
rm -f "$staging/rootfs/.dockerenv" "$staging/rootfs/root/.ash_history" "$staging/rootfs/etc/machine-id"
rm -rf "$staging/rootfs/tmp"/* "$staging/rootfs/var/cache/apk"/* "$staging/rootfs/var/log"/*
rm -rf "$staging/rootfs/var/lib/dhcp" "$staging/rootfs/var/lib/NetworkManager" "$staging/rootfs/etc/ssh/ssh_host_"*
rm -rf "$staging/rootfs/usr/share/doc" "$staging/rootfs/usr/share/info" "$staging/rootfs/usr/share/man" "$staging/rootfs/usr/share/locale"
rm -rf "$staging/rootfs/dev"/*
rm -f "$staging/rootfs/usr/sbin/setup-alpine" "$staging/rootfs/usr/sbin/setup-sshd" "$staging/rootfs/etc/init.d/firstboot"
find "$staging/rootfs" -xdev \( -name '*.log' -o -name 'build.log' \) -type f -delete

node "$root/scripts/scan-vm-image.mjs" "$staging/rootfs"

kernel_version=$(find "$staging/rootfs/lib/modules" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort)
if [[ $(printf '%s\n' "$kernel_version" | sed '/^$/d' | wc -l) -ne 1 ]]; then
  echo 'expected exactly one Linux module directory in exported Alpine rootfs' >&2
  exit 1
fi
module_root="$staging/rootfs/lib/modules/$kernel_version"
required_modules=(kernel/drivers/block/loop.ko.gz kernel/fs/squashfs/squashfs.ko.gz kernel/fs/netfs/netfs.ko.gz kernel/fs/9p/9p.ko.gz kernel/net/9p/9pnet.ko.gz kernel/net/9p/9pnet_virtio.ko.gz)
for module in "${required_modules[@]}"; do test -f "$module_root/$module" || { echo "missing required boot module: $module" >&2; exit 1; }; done
mkdir -p "$staging/modules/$kernel_version"
for module in "${required_modules[@]}"; do
  mkdir -p "$staging/modules/$kernel_version/$(dirname "$module")"
  cp -a "$module_root/$module" "$staging/modules/$kernel_version/$module"
done
find "$module_root" -maxdepth 1 -type f -name 'modules.*' -exec cp -a {} "$staging/modules/$kernel_version/" \;
rm -rf "$staging/rootfs/lib/modules"
mkdir -p "$staging/rootfs/lib"
cp -a "$staging/modules" "$staging/rootfs/lib/modules"

test -f "$staging/rootfs/boot/vmlinuz-virt"
cp "$staging/rootfs/boot/vmlinuz-virt" "$root/public/v86/vmlinuz-virt"
rm -rf "$staging/rootfs/boot"
( cd "$staging/rootfs" && find . -xdev -print0 | LC_ALL=C sort -z | xargs -0 touch -h -d '@0' )
( cd "$staging/rootfs" && find . -xdev -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' path; do
  path=${path//\\/\\\\}
  path=${path// /\\040}
  printf '%s 0\n' "$path"
done ) > "$staging/rootfs.sort"
docker run --rm --platform linux/386 --mount "type=bind,src=$staging/rootfs,dst=/input,readonly" --mount "type=bind,src=$staging/output,dst=/output" --mount "type=bind,src=$staging/rootfs.sort,dst=/input.sort,readonly" "$image" mksquashfs /input /output/kcode-rootfs.sqfs -noappend -no-progress -processors 1 -comp xz -b 1048576 -Xdict-size 1048576 -no-xattrs -all-root -mkfs-time 0 -all-time 0 -sort /input.sort
test -s "$staging/output/kcode-rootfs.sqfs"
if [[ $(stat -c '%s' "$staging/output/kcode-rootfs.sqfs") -gt $rootfs_limit ]]; then echo "kcode-rootfs.sqfs exceeds the standard 256 MiB boot limit of $rootfs_limit bytes" >&2; exit 1; fi
docker run --rm --platform linux/386 --mount "type=bind,src=$staging/output,dst=/input,readonly" --mount "type=bind,src=$root/scripts,dst=/scripts,readonly" "$image" sh -ec 'unsquashfs -no-progress -d /verified /input/kcode-rootfs.sqfs >/dev/null && node /scripts/scan-vm-image.mjs /verified'
cp "$staging/output/kcode-rootfs.sqfs" "$root/public/v86/kcode-rootfs.sqfs"

mkdir -p "$staging/loader/bin" "$staging/loader/lib" "$staging/loader/dev" "$staging/loader/proc" "$staging/loader/sys" "$staging/loader/newroot"
cp -a "$staging/rootfs/bin/busybox" "$staging/loader/bin/busybox"
ln -s busybox "$staging/loader/bin/sh"
for applet in mount modprobe losetup switch_root; do ln -s busybox "$staging/loader/bin/$applet"; done
cp -a "$staging/rootfs/lib/ld-musl-i386.so.1" "$staging/loader/lib/ld-musl-i386.so.1"
cp -a "$staging/rootfs/lib/modules" "$staging/loader/lib/modules"
cp "$staging/output/kcode-rootfs.sqfs" "$staging/loader/kcode-rootfs.sqfs"
cat > "$staging/loader/init" <<'EOF'
#!/bin/sh
export PATH=/bin
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys
for module in loop squashfs netfs 9p 9pnet 9pnet_virtio; do
  modprobe "$module" || exit 1
done
losetup /dev/loop0 /kcode-rootfs.sqfs
mount -t squashfs -o ro /dev/loop0 /newroot
mount --move /dev /newroot/dev
exec switch_root /newroot /sbin/init
EOF
chmod 0755 "$staging/loader/init"
( cd "$staging/loader" && find . -xdev -print0 | LC_ALL=C sort -z | xargs -0 touch -h -d '@0' )
docker run --rm --platform linux/386 --mount "type=bind,src=$staging/loader,dst=/input,readonly" --mount "type=bind,src=$staging/output,dst=/output" "$image" sh -ec 'cd /input && find . -xdev -print0 | LC_ALL=C sort -z | cpio -0 -o -H newc -R 0:0 --ignore-devno --renumber-inodes | xz --threads=1 --check=crc32 -9e > /output/kcode-initramfs'
test -s "$staging/output/kcode-initramfs"
if [[ $(stat -c '%s' "$staging/output/kcode-initramfs") -gt $initramfs_wire_limit ]]; then echo "kcode-initramfs exceeds the v86 64 MiB on-wire limit of $initramfs_wire_limit bytes" >&2; exit 1; fi
cp "$staging/output/kcode-initramfs" "$root/public/v86/kcode-initramfs"

node --input-type=module - "$root/public/v86/asset-manifest.json" "$root/vm/alpine/apk.lock" <<'NODE'
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const [manifestPath, lockPath] = process.argv.slice(2);
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.alpine.apkLockSha256 = await hash(lockPath);
for (const name of ['vmlinuz-virt', 'kcode-initramfs', 'kcode-rootfs.sqfs']) manifest.assets[name] = await hash(new URL(`./${name}`, `file://${manifestPath}`).pathname);
manifest.assets['alpine-state.bin.zst'] = null;
manifest.snapshot.assetSetSha256 = null;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

echo 'Generated reproducible vmlinuz-virt, embedded SquashFS root, and loader initramfs; build the snapshot next.'
