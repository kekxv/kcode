# HIX.AI Support and Local Work History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an exact-origin HIX.AI chat adapter and a user-visible, bounded local record of kcode work runs.

**Architecture:** Extend the existing immutable origin/provider registry with `https://hix.ai`, mapping only the verified `/ai-chat` page to a selector-isolated adapter. Add a Side Panel-owned `WorkHistoryStore` over trusted `chrome.storage.local`; it persists sanitized task/outcome records only after a run completes, retains at most 100 records/256 KiB total, and exposes clear-all rather than any cross-site sync.

**Tech Stack:** Chrome MV3, TypeScript, Vue 3, Vitest, Playwright.

**Spec:** `AI.md`; user request on 2026-09-05: HIX.AI support and extension-local chat/work records.

## Global Constraints

- Manifest permissions remain exactly `sidePanel`, `storage`; no `tabs`, `activeTab`, wildcard or optional host permissions.
- The only new host permission and content-script match is `https://hix.ai/*`; background trust accepts the exact origin `https://hix.ai` in a top-level frame only.
- HIX page DOM is untrusted. Its adapter requires exactly one visible/enabled composer and send control; ambiguity fails closed.
- Work records remain in `chrome.storage.local` with trusted-context access. They never include page HTML, provider cookies, URLs, tool-call arguments, raw terminal output, filesystem contents, or consent/credential values.
- Persisted text must pass the existing result redaction boundary; storage schema validation clears malformed data rather than returning it.
- Retain at most 100 entries and 256 KiB UTF-8 total. Newest entries displace oldest; clear-all deletes the entire namespaced key.

---

### Task 1: Authorize HIX.AI exactly and register its adapter

**Files:**
- Modify: `manifest.json`, `scripts/security-source-scan.mjs`, `src/background/port-router.ts`, `src/types/protocol.ts`, `src/content/adapters/registry.ts`
- Create: `src/content/adapters/hix.ts`
- Modify: `tests/unit/manifest.test.ts`, `tests/security/message-auth.test.ts`, `tests/unit/background-router.test.ts`, `tests/unit/content/registry.test.ts`, `tests/unit/content/provider-adapters.test.ts`, `tests/e2e/extension.spec.ts`

**Interfaces:** `HixAdapter extends DeepSeekAdapter`; `hixSelectors: ChatSelectors`; `adapterForOrigin('https://hix.ai', document)` returns `HixAdapter`; trusted provider label is `HIX.AI`.

- [ ] **Step 1: Write failing host, sender, registry, and selector tests**

```ts
expect(manifest.host_permissions).toContain('https://hix.ai/*');
expect(isTrustedChatSender(sender({ origin: 'https://hix.ai' }))).toBe(true);
expect(adapterForOrigin('https://hix.ai', document)).toBeInstanceOf(HixAdapter);
expect(hixSelectors.composer[0]).toBe('form#hix-chat-form [role="textbox"][contenteditable="true"]');
```

- [ ] **Step 2: Run focused tests to verify red**

Run: `npm run test:run -- tests/unit/manifest.test.ts tests/security/message-auth.test.ts tests/unit/background-router.test.ts tests/unit/content/registry.test.ts tests/unit/content/provider-adapters.test.ts`

Expected: FAIL because HIX is absent from exact permission, provider, and adapter registries.

- [ ] **Step 3: Implement the minimal exact-origin HIX adapter**

```ts
export const hixSelectors: ChatSelectors = {
  composerRegion: ['form#hix-chat-form'],
  composer: ['form#hix-chat-form [role="textbox"][contenteditable="true"]'],
  send: ['form#hix-chat-form button[type="submit"]', 'form#hix-chat-form button[aria-label="Send"]'],
  assistantList: ['main'],
  assistant: ['[data-message-author-role="assistant"]', '[data-role="assistant"]'],
  stop: ['button[aria-label="Stop generating"]', 'button[aria-label="Stop"]'],
};
```

Add HIX to every exact-origin switch/list, source scan expected hosts, manifest match list, provider union, and registry. Do not add a broad fallback outside `form#hix-chat-form`.

- [ ] **Step 4: Run focused checks and the packaged-permission E2E test**

Run: `npm run test:run -- tests/unit/manifest.test.ts tests/security/message-auth.test.ts tests/unit/background-router.test.ts tests/unit/content && npm run security:source && npm run build && npm run test:e2e`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add manifest.json scripts/security-source-scan.mjs src/background/port-router.ts src/types/protocol.ts src/content/adapters/hix.ts src/content/adapters/registry.ts tests
git commit -m "feat: add exact-origin HIX AI adapter"
```

### Task 2: Persist bounded, redacted local work records

**Files:**
- Create: `src/sidepanel/work-history.ts`, `tests/unit/work-history.test.ts`
- Modify: `src/sidepanel/App.vue`, `tests/unit/sidepanel.test.ts`

**Interfaces:** `WorkRecord = { id: string; createdAt: number; provider: ChatProvider; task: string; outcome: string; status: 'completed' | 'failed' }`; `WorkHistoryStore.load(): Promise<readonly WorkRecord[]>`, `append(record): Promise<readonly WorkRecord[]>`, `clear(): Promise<void>`.

- [ ] **Step 1: Write failing storage tests**

```ts
await store.append({ id: 'run-1', createdAt: 1, provider: 'HIX.AI', task: 'summarize', outcome: 'done', status: 'completed' });
await expect(store.load()).resolves.toEqual([{ id: 'run-1', createdAt: 1, provider: 'HIX.AI', task: 'summarize', outcome: 'done', status: 'completed' }]);
```

Add tests that reject malformed records by clearing storage, trim oldest records after the 100-entry/256-KiB boundary, and do not persist a value larger than the per-field UTF-8 caps.

- [ ] **Step 2: Run work-history tests to verify red**

Run: `npm run test:run -- tests/unit/work-history.test.ts`

Expected: FAIL because `WorkHistoryStore` does not exist.

- [ ] **Step 3: Implement schema validation, bounds, and clear-all**

Use key `kcode.work-history.v1`; validate exact record keys, safe timestamp, known `ChatProvider`, ID format, status, and bounded text. Serialize before write and retain newest complete records only while within 100 entries and 256 KiB. Invalid durable data is removed and `load()` returns `[]`.

- [ ] **Step 4: Persist only finalized, guarded task outcomes in App**

Load history on mount. On `orchestrator.run()` completion, derive provider from the selected trusted tab, run the stored display text through the existing `ResultGuard`, append one record, and keep storage failures non-authoritative for the task result. Do not store deltas, tool arguments, terminal chunks, or raw page response text.

- [ ] **Step 5: Run focused tests to verify green**

Run: `npm run test:run -- tests/unit/work-history.test.ts tests/unit/sidepanel.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/work-history.ts src/sidepanel/App.vue tests/unit/work-history.test.ts tests/unit/sidepanel.test.ts
git commit -m "feat: retain bounded local work history"
```

### Task 3: Add an accessible history viewer and document privacy

**Files:**
- Create: `src/sidepanel/components/WorkHistory.vue`
- Modify: `src/sidepanel/App.vue`, `README.md`, `docs/security.md`, `tests/unit/sidepanel.test.ts`

**Interfaces:** `WorkHistory` accepts `records: readonly WorkRecord[]` and emits `clear`; UI renders task/provider/status/timestamp/outcome as text only.

- [ ] **Step 1: Write the failing Side Panel behavior tests**

```ts
expect(await screen.findByRole('region', { name: '工作记录' })).toHaveTextContent('HIX.AI');
await fireEvent.click(screen.getByRole('button', { name: '清除工作记录' }));
await waitFor(() => expect(services.workHistory.clear).toHaveBeenCalledOnce());
```

- [ ] **Step 2: Run focused UI test to verify red**

Run: `npm run test:run -- tests/unit/sidepanel.test.ts`

Expected: FAIL because the record viewer and service dependency are absent.

- [ ] **Step 3: Implement text-only viewer and wiring**

Render a labelled `工作记录` region, newest first, with a clear button. No `v-html`, no links built from record data, and no automatic resubmission of a previous task. Update the injected `SidePanelServices` and production bootstrap with `WorkHistoryStore`.

- [ ] **Step 4: Update documentation**

Document HIX exact permission, local-only work-history contents and limits, clearing behavior, and the fact that HIX's guest policy may still require sign-in/credits for an actual answer.

- [ ] **Step 5: Run release verification**

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/WorkHistory.vue src/sidepanel/App.vue README.md docs/security.md tests/unit/sidepanel.test.ts
git commit -m "docs: expose private local work history"
```

## Self-review

- Exact HIX origin, DOM contract, registry, trusted label, and packaged scope are covered by Task 1.
- Task 2 persists only bounded local finalized records and validates durable data before use.
- Task 3 exposes the user controls and documents privacy/guest limitations.
- No wildcard permissions, provider-native prompt modification, storage of DOM/cookies/tool arguments, or automatic replay is introduced.
