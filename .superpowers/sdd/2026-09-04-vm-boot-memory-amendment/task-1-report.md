# Task 1 Report — deterministic two-stage 256 MiB Alpine boot

## Delivered

- Built a deterministic XZ cpio loader with BusyBox applets, loop/SquashFS/9P
  module closure and indexes, and an embedded deterministic
  `kcode-rootfs.sqfs` mounted read-only at `/dev/loop0` before `switch_root`.
- Pinned `squashfs-tools=4.6.1-r1`, trimmed the exported root, removed unused
  provisioning scripts that contained protected-path strings, and preserved
  protected-marker scanning before packaging and in the raw snapshot state.
- Added the root image to the manifest, snapshot asset set, fail-closed hash
  verifier, and 60 MiB standard-256-MiB boot limit.
- Captured raw state through a browser download (never CDP array/string
  serialization), byte-compared two fresh interpreter states, then zstd
  compressed in Node. The standard runtime also uses 256 MiB and the same
  interpreter setting as the captured snapshot.

## TDD evidence

- RED: the new asset-layout tests failed because the manifest omitted the
  SquashFS root and the old initramfs had no loader.
- RED: real serial boot found missing BusyBox applet links; the new loader
  applet test failed until they were added.
- RED: real serial boot found that `devtmpfs` was not moved into the
  read-only root; the loader-order assertion failed until the mount move was
  added.
- RED: the runtime still configured 128 MiB; its literal 256 MiB contract
  failed until the standard boot size changed.

## Fresh verification

- `./scripts/build-alpine-guest.sh` — built 37.5 MiB SquashFS and a 39 MiB
  embedded-loader initramfs; live v86 serial reached `KCODE_GUEST_READY`.
- `node scripts/build-v86-snapshot.mjs` — passed two-fresh-state byte compare,
  marker scan, and wrote `alpine-state.bin.zst` (93 MiB zstd).
- `npm run assets:verify` — passed.
- `DISPLAY=:99 KCODE_VM_TEST=1 npm run test:run -- tests/integration/vm-smoke.test.ts`
  — 8 passed, including packaged Worker snapshot restore and `KCODE_SMOKE`.
- `npm run test:run` — 17 files, 115 passed, 1 gated skip.
- `npm run typecheck` and `git diff --check` — passed.

## Environment note

The packaged smoke test is headed because Chrome extension loading requires it.
The initial run had no X server; rerunning with the available local Xvfb on
`DISPLAY=:99` passed. Generated kernel/initramfs/root/snapshot binaries remain
ignored.
