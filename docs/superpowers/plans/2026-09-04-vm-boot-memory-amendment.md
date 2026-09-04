# VM Boot and Memory Amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boot the reproducible Alpine guest reliably with a two-stage image and support user-selected 256 MiB or 512 MiB cold boots.

**Architecture:** A small deterministic cpio initramfs contains a compressed, hash-verified SquashFS root image at `/kcode-rootfs.sqfs`, loads only the loop/squashfs/9P module closure, mounts that image read-only, then `switch_root`s into Alpine. Embedding the already-compressed SquashFS keeps the on-wire initrd below v86's 64 MiB window without expanding the entire rootfs at boot. VM memory is selected before Worker construction; 256 MiB is the default and 512 MiB is an explicit high-memory cold-boot mode. Snapshots and smoke assets are memory-profile-specific so state from one RAM geometry is never restored into another.

**Tech Stack:** Chrome MV3 Dedicated Worker, v86, Alpine i386 Docker image, BusyBox initramfs, SquashFS, Node.js asset scripts, Vitest, Playwright.

**Spec:** `AI.md`; this amendment supersedes the original plan's fixed `128 MiB` VM-memory requirement after the user's explicit approval on 2026-09-04.

## Global Constraints

- Memory profiles are exactly `256` and `512` MiB; default is `256` MiB; no hot-resize exists.
- A profile switch terminates the Worker and is a cold boot; never preserve a command, workspace mount, relay, or snapshot across profiles.
- Keep `net_device` absent; WISP remains a later cold-boot-only feature.
- Generated kernel, initramfs, SquashFS, and snapshots remain ignored; manifest hashes and source recipes are committed.
- The root image excludes guest workspaces and protected-path markers; 9P `host9p` remains unmounted until Task 7 authorization.
- Fail closed on a missing/mismatched profile asset, root-image hash, snapshot asset-set hash, or RAM-profile mismatch.

---

### Task 1: Build and verify a two-stage Alpine boot image

**Files:**
- Modify: `vm/alpine/Dockerfile`
- Modify: `vm/alpine/apk.lock`
- Modify: `vm/alpine/etc/local.d/kcode.start`
- Modify: `scripts/build-alpine-guest.sh`
- Modify: `scripts/verify-vm-assets.mjs`
- Modify: `public/v86/asset-manifest.json`
- Modify: `public/v86/README.md`
- Test: `tests/integration/vm-smoke.test.ts`

**Interfaces:**
- Consumes: pinned Alpine rootfs and `squashfs-tools=4.6.1-r1`.
- Produces: `kcode-initramfs` (XZ cpio containing a small loader and `/kcode-rootfs.sqfs`), `kcode-rootfs.sqfs`, `vmlinuz-virt`; loader invokes `switch_root /newroot /sbin/init` after mounting the embedded image through `/dev/loop0` as SquashFS.

- [ ] **Step 1: Write failing asset-layout tests**

Add tests that require the manifest to list `kcode-rootfs.sqfs`, reject a root image over the profile-specific boot limit, and require the loader script to mount a read-only SquashFS before `switch_root`.

- [ ] **Step 2: Run the asset-layout tests to verify RED**

Run: `npm run test:run -- tests/integration/vm-smoke.test.ts`

Expected: FAIL because the manifest and loader do not yet expose a SquashFS root image.

- [ ] **Step 3: Implement deterministic two-stage construction**

Install the pinned `squashfs-tools`, export and sanitize rootfs, retain exactly the verified `loop`, `squashfs`, `netfs`, `9p`, `9pnet`, and `9pnet_virtio` module closure plus indexes, build `kcode-rootfs.sqfs` with sorted entries, numeric owners, epoch timestamps, `-no-xattrs`, and a fixed compressor configuration. Build a minimal cpio with `/init`, BusyBox, required kernel modules/indexes, `/proc`, `/sys`, `/dev`, and the root image copied at `/kcode-rootfs.sqfs`; its init script loads loop/squashfs, mounts that file read-only, mounts pseudo-filesystems, then `exec switch_root /newroot /sbin/init`.

- [ ] **Step 4: Enforce hash and marker verification**

Add `kcode-rootfs.sqfs` to the manifest/expected asset set. Verify every profile boot asset hash, reject rootfs containing protected markers, and require all generated root/init assets before a snapshot can be created.

- [ ] **Step 5: Run real 256 MiB guest readiness verification**

Run: `./scripts/build-alpine-guest.sh && node scripts/build-v86-snapshot.mjs`

Expected: serial contains `KCODE_GUEST_READY`; no protected marker scan failure; no workspace/relay configured.

- [ ] **Step 6: Commit**

```bash
git add vm/alpine scripts/build-alpine-guest.sh scripts/verify-vm-assets.mjs public/v86/asset-manifest.json public/v86/README.md tests/integration/vm-smoke.test.ts
git commit -m "feat: boot alpine from deterministic squashfs root"
```

### Task 2: Add profile-selected 256/512 MiB cold boots

**Files:**
- Modify: `src/types/protocol.ts`
- Modify: `src/worker/v86-runtime.ts`
- Modify: `src/worker/vm.worker.ts`
- Modify: `src/sidepanel/vm-client.ts`
- Modify: `src/sidepanel/App.vue`
- Modify: `tests/integration/vm-smoke.test.ts`
- Test: `tests/unit/protocol.test.ts`
- Test: `tests/unit/vm-worker.test.ts`

**Interfaces:**
- Consumes: `VM_INIT` session and `memoryProfile: 256 | 512`.
- Produces: `VM_MEMORY_PROFILES = { standard: 256 MiB, high: 512 MiB }`; Worker rejects unrecognized profiles, destroys the old generation before a changed profile boot, and selects only the matching snapshot asset.

- [ ] **Step 1: Write failing profile protocol tests**

Assert omitted profile normalizes to `standard`, `high` requires an explicit user-originated action in the side panel, and a changed profile produces a new Worker generation with no retained mount or serial request id.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npm run test:run -- tests/unit/protocol.test.ts tests/unit/vm-worker.test.ts tests/integration/vm-smoke.test.ts`

Expected: FAIL because memory profile is absent from the protocol/runtime.

- [ ] **Step 3: Implement profile normalization and cold-boot selection**

Define a closed `MemoryProfile` union. Pass it only in `VM_INIT`; use `256 * 1024 * 1024` or `512 * 1024 * 1024` at V86 construction. On a profile change, terminate the existing Worker before creating a new one; use a separate, manifest-bound snapshot filename for each profile and never fall back to a differently sized snapshot.

- [ ] **Step 4: Implement visible user choice and warning**

Add a side-panel control defaulting to Standard (256 MiB). High (512 MiB) requires an explicit click and explains that it cold-restarts the VM, loses active command state, and increases browser memory use. Persist no profile consent beyond the current browser session.

- [ ] **Step 5: Verify both profiles**

Run: `KCODE_VM_TEST=1 npm run test:run -- tests/integration/vm-smoke.test.ts && npm run typecheck`

Expected: the real 256 MiB image reaches ready/echo; profile unit tests prove 512 uses a cold Worker generation and cannot reuse the 256 snapshot.

- [ ] **Step 6: Commit**

```bash
git add src/types/protocol.ts src/worker src/sidepanel tests/unit/protocol.test.ts tests/unit/vm-worker.test.ts tests/integration/vm-smoke.test.ts
git commit -m "feat: add cold-boot vm memory profiles"
```

### Task 3: Generate profile-bound snapshots and close the release gate

**Files:**
- Modify: `scripts/build-v86-snapshot.mjs`
- Modify: `scripts/verify-vm-assets.mjs`
- Modify: `public/v86/asset-manifest.json`
- Modify: `tests/integration/vm-smoke.test.ts`
- Modify: `docs/superpowers/plans/2026-09-04-kcode-mvp.md`

**Interfaces:**
- Consumes: two-stage 256 MiB boot assets and `MemoryProfile` constants.
- Produces: deterministic `alpine-state-256.bin.zst` and optional `alpine-state-512.bin.zst`, each manifest-bound to exact RAM bytes and root/init/kernel hashes.

- [ ] **Step 1: Write failing profile-snapshot verifier tests**

Assert a manifest snapshot with the wrong `memoryBytes`, a cross-profile asset-set digest, or an absent 256 snapshot fails verification with a specific error.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run test:run -- tests/integration/vm-smoke.test.ts && npm run assets:verify`

Expected: FAIL until profile-specific snapshot metadata exists.

- [ ] **Step 3: Implement deterministic profile snapshot capture**

Capture two fresh deterministic 256 MiB states before writing `alpine-state-256.bin.zst`; store memory bytes, v86 version, rootfs hash, kernel/initrd hashes, and profile asset-set digest. Generate 512 only through an explicit script argument and reject overwriting/cross-binding either profile.

- [ ] **Step 4: Execute release verification**

Run: `npm run assets:sync && ./scripts/build-alpine-guest.sh && node scripts/build-v86-snapshot.mjs --profile standard && npm run assets:verify && KCODE_VM_TEST=1 npm run test:run -- tests/integration/vm-smoke.test.ts && npm run test:run && npm run typecheck && npx vite build`

Expected: all assets verify; real standard-profile Worker returns `KCODE_SMOKE`; all unit tests/build checks pass; high-profile tests use a separately bound asset or fail closed when it has not been built.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-v86-snapshot.mjs scripts/verify-vm-assets.mjs public/v86/asset-manifest.json tests/integration/vm-smoke.test.ts docs/superpowers/plans/2026-09-04-kcode-mvp.md
git commit -m "feat: bind vm snapshots to memory profiles"
```
