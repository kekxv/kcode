# Verified v86 assets

This directory contains a checked-in, pinned boot asset set used by the
extension and CI. Ordinary users build directly from these files with no
container runtime: `npm run assets:verify` checks their manifest, hashes and
wire-size limits. To intentionally regenerate them, run
`npm run assets:rebuild` in a Docker or Docker-compatible Podman environment;
it synchronizes v86 assets, rebuilds the guest, and runs deep verification.
The initramfs contains only a BusyBox loader, the loop/SquashFS/9P module
closure, and a deterministic `kcode-rootfs.sqfs` mounted read-only before
`switch_root`; it never mounts a workspace or configures a relay. The rootfs is
embedded only in the initramfs, not duplicated as a distributable asset.

`npm run assets:verify` is fail-closed. It checks the pinned v86 package and
Alpine OCI metadata, the complete APK lock digest, every boot asset's SHA-256,
and the initramfs's 64 MiB v86 on-wire limit. `npm run assets:verify:deep`
adds the Docker-based check of the standard 256 MiB root-image limit. It uses the pinned Alpine container to
decompress/extract the cpio, requires its embedded `/kcode-rootfs.sqfs`, checks
its 60 MiB boot limit, and scans the extracted filesystem for protected
markers and symlink targets. The build also uses that locked container's
cpio/xz tools and scans before final SquashFS packaging. Do not hand-copy an
asset into this directory.

The extension does not distribute a machine snapshot. On a user's first
offline boot, it may save a browser-local state before any workspace is
attached; a later offline boot with the same RAM profile may restore that local
state. Networked boots and every other profile cold-boot from these verified
assets. Local states are never packaged, committed, or sent to a relay.
