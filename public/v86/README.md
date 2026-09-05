# Verified v86 assets

This directory contains a checked-in, pinned boot asset set used by the
extension and CI. Regenerate it with `npm run assets:sync` and
`./scripts/build-alpine-guest.sh`, then run `npm run assets:verify` before
committing the changed binaries.
The initramfs contains only a BusyBox loader, the loop/SquashFS/9P module
closure, and a deterministic `kcode-rootfs.sqfs` mounted read-only before
`switch_root`; it never mounts a workspace or configures a relay.

`npm run assets:verify` is fail-closed. It checks the pinned v86 package and
Alpine OCI metadata, the complete APK lock digest, every boot asset's SHA-256,
the standard 256 MiB root-image limit, the initramfs's 64 MiB v86 on-wire
limit. It uses the pinned Alpine container to
decompress/extract the cpio and requires its embedded `/kcode-rootfs.sqfs` to
match both the loose asset and manifest hash. The build also uses that locked
container's cpio/xz tools and scans protected markers and symlink targets both
before and after final SquashFS packaging. Do not hand-copy an asset into this
directory.

The extension does not distribute a machine snapshot. On a user's first
offline boot, it may save a browser-local state before any workspace is
attached; a later offline boot with the same RAM profile may restore that local
state. Networked boots and every other profile cold-boot from these verified
assets. Local states are never packaged, committed, or sent to a relay.
