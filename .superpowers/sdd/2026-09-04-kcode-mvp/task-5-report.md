# Task 5 Report — v86 Alpine runtime pipeline

## Changed files

- Added the checked v86/Alpine asset manifest, source-only asset documentation,
  deterministic asset sync and fail-closed verification scripts.
- Added the pinned i386 Alpine Docker recipe, complete resolved APK lock, guest
  ready hook, reproducible initramfs/kernel builder, and snapshot builder.
- Added `V86Runtime` and replaced the fail-closed worker placeholder with an
  authorized runtime boundary using exactly 128 MiB, empty built-in 9P, no
  network device, bounded serial output, and Worker shutdown for command paths.
- Added the runtime smoke/configuration contract and ignored generated VM
  binaries while retaining the manifest and recipes in Git.

## Commit

- `feat: add reproducible v86 alpine runtime` (created after final checks)

## TDD and checks

- RED: `npm run test:run -- tests/integration/vm-smoke.test.ts` failed because
  `src/worker/v86-runtime.ts` was absent.
- RED: `npm run assets:verify` failed because the verifier was absent; after
  implementation it fails closed with the precise remaining generated-asset
  requirements.
- GREEN: `npm run test:run` — 14 files, 87 passed, 1 gated skipped.
- GREEN: `npm run typecheck` — passed.
- GREEN: `npx vite build` — passed (existing Vite config and v86 browser
  externalization warnings only).
- GREEN: `node --check` for all JavaScript scripts, `bash -n` for guest build,
  and `git diff --check` — passed.

## Blocker / deviation

The required `docker build --platform linux/386` reached 44/66 pinned APK
installs, then stalled without output during cross-architecture execution and
was interrupted. No Docker containers remain. Therefore this environment could
not generate `vmlinuz-virt`, `kcode-initramfs`, or `alpine-state.bin.zst`; the
fail-closed verifier correctly remains non-zero for those missing artifacts.
The BIOS and wasm were synchronized and verified but remain ignored, as
required. Run the documented build chain on a host where the i386 Docker build
completes to produce and verify the release-only assets.
