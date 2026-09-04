# Task 7 report — confined 9P workspace backend

## Delivered behavior

- The guest mounts the selected FSA directory only at `/work`; Worker commands execute as `cd /work && …`.
- `FsaBackend` uses root-handle-only traversal, exact `root.resolve()` confinement, protected-path filtering/denial, capability checks, bounded I/O, and per-path locks.
- Mutations require an approved transaction. `VM_BEGIN_TRANSACTION` carries only an ID: its capabilities are derived from the immutable session admitted by `VM_INIT`, never from guest-facing input. Commit and rollback revoke the transaction policy afterwards.
- Rollback journal entries are AES-GCM encrypted with an origin-local, non-extractable IndexedDB key. The key store now upgrades an existing `kcode` IndexedDB database that predates `security-keys`.
- FSA operations that time out retain their mutation locks until their underlying, non-abortable promise settles. A timeout poisons the transaction and requires rollback before any subsequent mutation.
- The 9P `Rgetattr` wire encoding now contains the full Linux 9P2000.L metadata payload required by the real guest kernel.

## Fresh verification

```text
npm run test:run -- tests/unit/p9 tests/unit/journal-key.test.ts tests/security/resource-limits.test.ts tests/unit/vm-worker.test.ts tests/unit/protocol.test.ts tests/integration/vm-smoke.test.ts
9 files passed; 59 tests passed; 1 real-VM test skipped by default

npm run typecheck
exit 0

npm run assets:verify
VM asset verification passed

DISPLAY=:99 KCODE_VM_TEST=1 npm run test:run -- tests/integration/vm-smoke.test.ts
1 file passed; 13 tests passed
```

The real packaged extension test uses an actual OPFS `FileSystemDirectoryHandle`, a cold-booted Alpine v86 guest, and the 9P backend. It proves, through nonce-framed guest serial output and host OPFS checks:

- `pwd` is `/work`;
- `cat visible.txt` returns `host-visible`;
- `find` lists `./visible.txt` but not `./.env`;
- a default-policy write is denied with a nonzero result;
- direct `cat .env` is denied with a nonzero result;
- an approved transaction writes successfully (`KCODE_WRITE_DONE:0`); and
- explicit rollback removes that guest-written file from OPFS.

## Remaining limitation

`OpfsJournalStorage` is durable for the current transaction, but startup-wide enumeration and recovery of orphaned transaction directories is not yet implemented. Browser storage cleanup is also not a guarantee of physical secure erase by the browser/storage medium.
