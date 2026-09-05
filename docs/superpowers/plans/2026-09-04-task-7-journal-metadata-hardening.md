# Task 7 Journal Metadata Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This review request mandates inline execution with no subagents.

**Goal:** Make journal recovery and commit fail closed against allocated-state replay, cross-workspace ciphertext copying, and incomplete prepared records.

**Architecture:** Keep the existing transaction-directory journal, but stop treating an authenticated allocated manifest as proof that no host mutation occurred. Give every journal storage an explicit workspace binding and authenticate that binding in both AES-GCM additional data and encrypted plaintext. Validate commit eligibility from freshly read durable records before writing finished metadata or clearing storage.

**Tech Stack:** TypeScript 5.9, Web Crypto AES-GCM, OPFS File System Access API, Vitest 5

**Spec:** `.superpowers/sdd/2026-09-04-kcode-mvp/task-7-brief.md`

## Global Constraints

- Use TDD: each production behavior is preceded by a focused failing test and an observed expected failure.
- Do not create subagents.
- Authentication failure or ambiguous recovery must preserve the durable journal and fail closed.
- Preserve the user's unrelated modification to `.superpowers/sdd/2026-09-04-kcode-mvp/task-5-report.md`.

---

### Task 1: Retain replayable allocated journals

**Files:**
- Modify: `tests/unit/p9/server.test.ts`
- Modify: `src/worker/p9/mutation-journal.ts`

**Interfaces:**
- Consumes: `MutationJournal.openExisting()` and `recoverConservatively()`
- Produces: allocated recovery rejects with `JOURNAL_RECOVERY_REQUIRED` without calling `JournalStorage.clear()`

- [x] **Step 1: Write the failing test**

Replace the obsolete cleanup expectation with a recovery test that saves an authenticated allocated manifest, advances the transaction to a prepared record, replays the old manifest while deleting the record, calls `P9Server.setRoot()`, expects `JOURNAL_RECOVERY_REQUIRED`, and then expects `OpfsJournalStorage.transactionIds('default')` still to contain the transaction ID.

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/unit/p9/server.test.ts -t "retains an authenticated allocated manifest replayed"`

Expected: FAIL because recovery currently resolves and deletes the transaction directory.

- [x] **Step 3: Write minimal implementation**

In `recoverConservatively()`, replace allocated-state cleanup with `throw new Error('JOURNAL_RECOVERY_REQUIRED')`; retain finished-state cleanup for an authenticated completed transaction.

- [x] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/unit/p9/server.test.ts -t "retains an authenticated allocated manifest replayed"`

Expected: PASS with the OPFS transaction still enumerable.

### Task 2: Authenticate the workspace binding

**Files:**
- Modify: `tests/unit/p9/mutation-journal.test.ts`
- Modify: `src/worker/p9/mutation-journal.ts`
- Modify: `src/worker/p9/server.ts`

**Interfaces:**
- Consumes: `JournalStorage`, `MemoryJournalStorage`, `OpfsJournalStorage`, `MutationJournal.begin()`, and `MutationJournal.openExisting()`
- Produces: `JournalStorage.workspaceBinding`; workspace-scoped record and metadata AES-GCM context plus plaintext envelopes

- [x] **Step 1: Write the failing test**

Create `MemoryJournalStorage('workspace-A')` and `MemoryJournalStorage('workspace-B')`, write an applied transaction in A, byte-copy every durable file to B under the same transaction ID and key, then expect `MutationJournal.openExisting()` in B to reject `JOURNAL_TAMPERED` while B's copied files remain.

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/unit/p9/mutation-journal.test.ts -t "rejects journal ciphertext copied to another workspace"`

Expected: FAIL because the copied metadata and record currently decrypt using transaction-ID-only AAD.

- [x] **Step 3: Write minimal implementation**

Add an immutable validated `workspaceBinding` to storage. Include `{ workspaceBinding, transactionId, schemaVersion: 2 }` in metadata AAD and plaintext. Include `{ workspaceBinding, transactionId, entryId, kind: 'journal-record', schemaVersion: 2 }` in record AAD and the encrypted record envelope, and validate all envelope fields on decrypt. Construct fallback memory storage with the server's current workspace binding.

- [x] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/unit/p9/mutation-journal.test.ts -t "rejects journal ciphertext copied to another workspace"`

Expected: PASS and copied files remain present.

### Task 3: Reject commit of incomplete records

**Files:**
- Modify: `tests/unit/p9/mutation-journal.test.ts`
- Modify: `src/worker/p9/mutation-journal.ts`

**Interfaces:**
- Consumes: `MutationJournal.commit()` and durable record phases
- Produces: `JOURNAL_NOT_APPLIED` rejection before any finished metadata write or cleanup

- [x] **Step 1: Write the failing test**

Begin a transaction, persist one prepared record without `setExpected()`, call `commit()`, expect `JOURNAL_NOT_APPLIED`, assert the complete storage name list is unchanged, and confirm `openExisting()` can still rehydrate the journal.

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/unit/p9/mutation-journal.test.ts -t "rejects commit while a durable record is still prepared"`

Expected: FAIL because commit currently marks the transaction finished and clears storage.

- [x] **Step 3: Write minimal implementation**

After `readDurableRecords()`, reject when any record has `phase !== 'applied'` or lacks `expected`; only then persist committed metadata and clear storage.

- [x] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/unit/p9/mutation-journal.test.ts -t "rejects commit while a durable record is still prepared"`

Expected: PASS with durable metadata and record bytes retained.

### Task 4: Regression verification and commit

**Files:**
- Verify: `src/worker/p9/mutation-journal.ts`
- Verify: `src/worker/p9/server.ts`
- Verify: `tests/unit/p9/mutation-journal.test.ts`
- Verify: `tests/unit/p9/server.test.ts`

**Interfaces:**
- Consumes: all three hardened invariants
- Produces: one reviewed commit containing only the plan, journal/server implementation, and relevant tests

- [x] **Step 1: Run focused Task 7 tests**

Run: `npm run test:run -- tests/unit/p9/fsa-backend.test.ts tests/unit/p9/mutation-journal.test.ts tests/unit/journal-key.test.ts tests/unit/p9/server.test.ts tests/security/p9-capability.test.ts tests/security/resource-limits.test.ts`

Expected: all selected tests pass with zero failures.

- [x] **Step 2: Run static verification**

Run: `npm run typecheck`

Expected: both `vue-tsc` and Node TypeScript checks exit zero.

- [ ] **Step 3: Review the diff and commit**

Run: `git diff --check && git diff -- src/worker/p9/mutation-journal.ts src/worker/p9/server.ts tests/unit/p9/mutation-journal.test.ts tests/unit/p9/server.test.ts docs/superpowers/plans/2026-09-04-task-7-journal-metadata-hardening.md`

Then stage only those five files and commit with `fix: harden journal metadata lifecycle`.
