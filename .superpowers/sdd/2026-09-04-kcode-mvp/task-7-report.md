# Task 7 report — confined 9P workspace backend

## Implemented scope

- Added `FsaBackend`: root-handle-only traversal, exact `root.resolve()` segment checks, sensitive-path rejection/filtering, per-operation capability checks, 30-second FSA deadlines, lexical multi-path locking, and bounded reads/writes/truncation/create/remove/rename.
- Added a 9P server over the Task 6 codec: bounded fids, in-flight requests, QIDs, queued mutations, request/reply lifecycle, 9P errno replies, and the required file/directory operations.
- Added an encrypted AES-GCM rollback-journal primitive and a non-extractable IndexedDB key store.
- Wired v86 `handle9p`; attaching a selected directory binds it with `['read']` and sends exactly:

  `mkdir -p /work; mountpoint -q /work || mount -t 9p -o trans=virtio,version=9p2000.L,cache=none host9p /work`

- Worker-dispatched commands now prefix `cd /work &&`; no Task 7 path uses `/workspace`, guest root, or home as the selected-directory mount.

## Automated verification

Passing (fresh run):

```text
npm run test:run -- tests/unit/p9 tests/unit/journal-key.test.ts tests/security/resource-limits.test.ts tests/unit/vm-worker.test.ts tests/integration/vm-smoke.test.ts
8 files passed, 38 tests passed, 1 production-VM test skipped

npm run typecheck
exit 0
```

Focused tests verify backend `resolve` confinement/read-only denial, encrypted rollback bytes, non-extractable keys, 9P version/attach replies, v86 `handle9p` registration and exact `/work` mount command, and `/work` command dispatch.

## Real guest-mount result

The required real guest integration is still incomplete, so no success is claimed for `pwd`, `cat`, `find`, read-only refusal, approved write, rollback, or protected-path denial.

`DISPLAY=:99 KCODE_VM_TEST=1 npm run test:run -- tests/integration/vm-smoke.test.ts` now launches the packaged extension and provisions a real OPFS `FileSystemDirectoryHandle` for attachment. The VM reaches OpenRC startup, but it has not reached the nonce-confirmed serial readiness/mount result before the real-test deadline. The test captures repeated echoed probe commands and OpenRC startup/mount output, but no `KCODE_GUEST_READY` marker line. Therefore no `/work` assertions were fabricated.

The server now journals every mutation before the FSA operation and exposes commit/rollback/recover methods. The currently defined VM message protocol has no authenticated transaction-escalation/commit/rollback request; adding that end-to-end approval lifecycle requires the Task 10 authority owner rather than accepting an untrusted worker message.

## Journal storage note

The journal key is non-extractable. Browser storage cleanup removes journal records, but this is not a guarantee of physical secure erase by the browser/storage medium.
