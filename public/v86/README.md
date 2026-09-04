# Verified v86 assets

This directory contains only the manifest and reproducible asset recipes in Git.
Generated binaries are ignored: run `npm run assets:sync`,
`./scripts/build-alpine-guest.sh`, and `node scripts/build-v86-snapshot.mjs`.
The initramfs contains only a BusyBox loader, the loop/SquashFS/9P module
closure, and a deterministic `kcode-rootfs.sqfs` mounted read-only before
`switch_root`; it never mounts a workspace or configures a relay.

`npm run assets:verify` is fail-closed. It checks the pinned v86 package and
Alpine OCI metadata, the complete APK lock digest, every boot asset's SHA-256,
the standard 256 MiB root-image size limit, the absence of unlisted binaries,
and snapshot compatibility. The build rejects protected paths and markers
before packaging the SquashFS root. Do not hand-copy an asset into this
directory.

The snapshot builder freezes the JavaScript clock/random sources available to
v86 and byte-compares a newly generated uncompressed state with any existing
verified state. A mismatch fails rather than overwriting the prior snapshot.
