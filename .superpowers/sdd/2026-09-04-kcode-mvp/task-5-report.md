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

- `a0cd089 feat: add reproducible v86 alpine runtime`
- `aebb371 fix: harden v86 boot readiness`
- `a49a298 fix: make v86 lifecycle deterministic`
- `5f43bcb fix: isolate deterministic v86 snapshots`

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

## Review repair

- `V86Runtime.boot` now waits up to 30 seconds for both `emulator-loaded` and
  a `KCODE_GUEST_READY` serial marker before the Worker emits `VM_READY`. A
  static serial probe makes the readiness proof available after restoring a
  snapshot, where the original marker predates the saved state.
- The Worker forwards runtime serial chunks as request-correlated
  `VM_OUTPUT_DELTA` events; VM event validation allows the runtime's 64 KiB
  maximum, while Chrome Port content deltas retain their stricter 32 KiB cap.
- The gated smoke test now serves and boots generated packaged assets in
  Chromium, asserts 128 MiB/no network configuration, waits for ready no more
  than 30 seconds, sends `echo KCODE_SMOKE`, and observes the serial marker.
- Snapshot creation freezes JavaScript time/random sources and rejects any
  byte difference from a previous verified uncompressed state. APK lock drift
  now always fails; no environment variable can overwrite the reviewed lock.

Repair verification: focused runtime/protocol tests passed (13 passed, 1
gated skip); full suite, typecheck, and Vite build passed (88 passed, 1 gated
skip). `assets:verify` remains correctly blocked only by the three absent
generated guest/snapshot artifacts and their derived manifest digest.

## Re-review repair

- Every snapshot build now captures two independent fresh VMs, resets
  `Date.now`, `Math.random`, and `performance.now` for each, and rejects any
  byte difference before writing an output; it no longer relies on a prior
  output file for the comparison.
- Worker lifecycle state uses a monotonically increasing generation. Stale
  boot completions/failures are ignored, while the successful init request ID
  remains the serial correlation until a later lifecycle transition.
- Runtime serial output is split by encoded UTF-8 bytes on Unicode scalar
  boundaries, including the U+FFFD expansion caused by invalid input bytes.
- The gated smoke now runs a Vite-served production Worker and production
  `V86Runtime` with the default snapshot URL; it verifies VM readiness and a
  serial `echo KCODE_SMOKE` round trip against the packaged assets.

Re-review verification: full Vitest suite passed (90 passed, 1 gated skip),
typecheck and Vite build passed, and JavaScript/shell syntax plus diff checks
passed. `assets:verify` remains fail-closed for the same absent generated
kernel/initramfs/snapshot artifacts; the i386 Docker build blocker remains
unchanged.

## Third repair

- Snapshot capture creates separate browser contexts for both fresh VMs, so
  v86 module state cannot cross the comparison. Each context installs fixed
  Date constructor/clock, performance clock, Math randomness, and Web Crypto
  randomness through an init script before importing `libv86`.
- The gated smoke runs a production-config Vite build as a loaded Chrome
  extension, obtains the generated worker chunk from that build, and keeps the
  same worker alive through `VM_INIT`, `VM_READY`, and `VM_EXEC` while checking
  the serial smoke delta. It no longer imports source `V86Runtime` in the test.

Third-repair verification: full Vitest suite passed (90 passed, 1 gated skip),
typecheck, production Vite build, JavaScript/shell syntax, and diff checks
passed. `assets:verify` remains intentionally non-zero only for the missing
generated kernel/initramfs/snapshot assets and snapshot manifest digest.
