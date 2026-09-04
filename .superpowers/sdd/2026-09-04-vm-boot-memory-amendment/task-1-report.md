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

## Review amendments (2026-09-04)

- The Docker image now pins `xz=5.8.3-r0`; deterministic newc cpio creation
  and XZ compression run only in that locked i386 container, never through
  host `cpio` or `xz`.
- The verifier now uses the same container to decompress/extract
  `kcode-initramfs` and fails closed unless its embedded
  `/kcode-rootfs.sqfs` SHA-256 equals both the loose root asset and manifest.
- Both construction and verification reject an initramfs larger than v86's
  64 MiB on-wire window. The builder scans rootfs symlink targets and scans
  the extracted final SquashFS before publishing it.
- Snapshot temporary output is removed in `finally`, including failed writes
  and failed renames.

### Amendment TDD and verification evidence

- RED: `npm run test:run -- tests/integration/vm-smoke.test.ts` produced the
  expected failures for an oversized initramfs, an embedded-root mismatch,
  and a protected symlink target.
- GREEN: the focused suite passed `10 passed, 1 skipped`; the real packaged
  256 MiB smoke then passed `11 passed`, including `KCODE_SMOKE`.
- Fresh checks: `./scripts/build-alpine-guest.sh` rebuilt a 37.55 MiB
  SquashFS and 38.7 MiB initramfs; `node scripts/build-v86-snapshot.mjs`,
  `npm run assets:verify`, `npm run typecheck`, and `npm run test:run` all
  passed (`118 passed, 1 skipped`).

### Scope note

The user requires future workspace-only work to use `/work`. This amendment
does not implement Task 7 or make any workspace mount changes.
