# VM Asset Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ordinary users build from the checked-in, hash-verified VM assets without Docker, while making Docker-based regeneration and deep guest inspection explicit maintainer choices.

**Architecture:** Keep the current manifest, file existence, hash, v86 package, APK-lock and compressed-initramfs size checks in the default verifier. Gate cpio extraction, embedded SquashFS inspection and image scanning behind `KCODE_VM_DEEP_VERIFY=1`; run that mode in CI and after explicit rebuilds only.

**Tech Stack:** Node.js asset scripts, npm scripts, GitHub Actions, Vitest, Docker (maintainer/CI only).

**Spec:** User request on 2026-09-05: users choose shipped repository assets or source regeneration; Docker must not be required for the normal path.

## Global Constraints

- Default `npm run build` and `npm run verify` must not invoke Docker.
- The extension continues to ship only the pinned `public/v86/` asset set.
- Deep inspection remains fail-closed in CI and after a source rebuild.
- Do not add browser permissions or change VM runtime behavior.

---

### Task 1: Split default and deep asset verification

**Files:**
- Modify: `scripts/verify-vm-assets.mjs`
- Modify: `tests/integration/vm-smoke.test.ts`

- [ ] Add a failing test that sets `KCODE_VM_DEEP_VERIFY=1` for the oversized embedded-rootfs fixture, proving only deep verification extracts the initramfs.
- [ ] Run `npm test -- --run tests/integration/vm-smoke.test.ts` and confirm the pre-change test fails because the verifier always inspects through Docker.
- [ ] Make embedded-rootfs extraction conditional on `KCODE_VM_DEEP_VERIFY === '1'`; retain all manifest, file, digest and on-wire-limit checks in default mode.
- [ ] Run the focused test and confirm the fixture is rejected in deep mode.

### Task 2: Make the asset source choice explicit

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/build.yml`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `public/v86/README.md`

- [ ] Add npm commands `assets:verify:deep` and `assets:rebuild`; the latter runs `assets:sync`, `build-alpine-guest.sh`, then deep verification.
- [ ] Keep `build` and `verify` on the Docker-free default verifier; add a separate CI deep verification step.
- [ ] Document two mutually exclusive paths: use checked-in assets (`npm ci && npm run build`) or regenerate assets (Docker/Podman-compatible Docker CLI, `npm run assets:rebuild`).
- [ ] Run `npm run verify` on an environment without requiring Docker and `npm run assets:verify:deep` where Docker is available.

### Task 3: Final verification and handoff

**Files:**
- Verify: repository-wide checks

- [ ] Run `npm run verify`.
- [ ] Run `git diff --check`.
- [ ] Commit the code, tests and documentation, fast-forward merge to `main`, and push `origin/main`.
