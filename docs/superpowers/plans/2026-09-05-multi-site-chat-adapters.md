# Multi-site Chat Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend kcode's authenticated webpage conversation bridge to ChatGPT, Qwen and Google AI Studio while retaining per-origin least privilege and fail-closed DOM operation.

**Architecture:** Keep one content-script entry and one `ContentController`; add a site registry that selects an explicit adapter solely from `location.origin`. Reuse the tested streaming lifecycle with selector contracts per provider. The background router recognizes only an immutable allow-list of exact origins.

**Tech Stack:** Chrome MV3, TypeScript, Vue 3, Vitest, Testing Library, Playwright.

**Spec:** `AI.md`; user request on 2026-09-05: `chat.qwen.ai`, `aistudio.google.com`, and ChatGPT web.

## Global Constraints

- Manifest permissions remain `sidePanel`, `storage`; never add `tabs`, `activeTab`, `<all_urls>`, or wildcard host permissions.
- Exact allowed origins are `https://chat.deepseek.com`, `https://chat.qwen.ai`, `https://aistudio.google.com`, and `https://chatgpt.com`.
- Content scripts run only in top frames and must select exactly one visible/enabled composer and send control or return `ADAPTER_DOM_CHANGED`.
- Page DOM/model output remains untrusted; all text crosses the existing bounded Port and is rendered as text only.
- Navigation, DOM ambiguity, response limits, page disconnect and abort remain fail-closed.
- Native provider system prompts are not edited. kcode supplemental instructions remain ordinary user-message content.

---

### Task 1: Make origin authorization an exact allow-list

**Files:**
- Modify: `manifest.json`, `src/background/port-router.ts`, `scripts/security-source-scan.mjs`
- Modify: `tests/unit/manifest.test.ts`, `tests/unit/background-router.test.ts`, `tests/security/message-auth.test.ts`

**Interfaces:** Produces `isTrustedChatSender(sender): boolean`, accepting only the four exact origins and top-level frames.

- [ ] **Step 1: Write the failing authorization and manifest tests**

```ts
expect(manifest.host_permissions).toEqual([
  'https://chat.deepseek.com/*', 'https://chat.qwen.ai/*',
  'https://aistudio.google.com/*', 'https://chatgpt.com/*',
]);
expect(isTrustedChatSender(sender({ origin: 'https://chat.qwen.ai' }))).toBe(true);
expect(isTrustedChatSender(sender({ origin: 'https://chat.qwen.ai.evil.example' }))).toBe(false);
```

- [ ] **Step 2: Run focused tests to verify red**

Run: `npm run test:run -- tests/unit/manifest.test.ts tests/unit/background-router.test.ts tests/security/message-auth.test.ts`

Expected: FAIL because only DeepSeek is accepted.

- [ ] **Step 3: Implement the immutable origin set**

```ts
export const SUPPORTED_CHAT_ORIGINS = new Set([
  'https://chat.deepseek.com', 'https://chat.qwen.ai',
  'https://aistudio.google.com', 'https://chatgpt.com',
]);
```

Require both `sender.origin` and `new URL(sender.url).origin` to be members, retain `frameId === 0`, and use the same set for tab identity checks. Make source scan assert the literal four-host permission contract.

- [ ] **Step 4: Run focused tests and source scan**

Run: `npm run test:run -- tests/unit/manifest.test.ts tests/unit/background-router.test.ts tests/security/message-auth.test.ts && npm run security:source`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add manifest.json src/background/port-router.ts tests/unit/manifest.test.ts tests/unit/background-router.test.ts tests/security/message-auth.test.ts scripts/security-source-scan.mjs
git commit -m "feat: authorize exact supported chat origins"
```

### Task 2: Add selector-isolated adapters and origin registry

**Files:**
- Create: `src/content/adapters/{selector-adapter,qwen,google-ai-studio,chatgpt,registry}.ts`
- Modify: `src/content/adapters/deepseek.ts`, `src/content/index.ts`
- Create: `tests/fixtures/{qwen,google-ai-studio,chatgpt}.html`
- Create: `tests/unit/content/{qwen,google-ai-studio,chatgpt,registry}.test.ts`

**Interfaces:** Produces `adapterForOrigin(origin, document): SiteAdapter | null`. Each adapter exports a named immutable selector contract and performs exact-one visible control selection.

- [ ] **Step 1: Write failing fixture tests**

For each provider fixture, test textarea/contenteditable input, bubbling `input` and `change`, send click, new-assistant-only incremental output, cancellation, and ambiguity returning `ADAPTER_DOM_CHANGED`. Add registry tests mapping the four exact origins and rejecting a spoofed origin.

```ts
await new QwenAdapter(document).sendPrompt('hello', signal);
expect(adapterForOrigin('https://chat.qwen.ai.evil', document)).toBeNull();
```

- [ ] **Step 2: Run adapter tests to verify red**

Run: `npm run test:run -- tests/unit/content/qwen.test.ts tests/unit/content/google-ai-studio.test.ts tests/unit/content/chatgpt.test.ts tests/unit/content/registry.test.ts`

Expected: FAIL because adapters and registry are absent.

- [ ] **Step 3: Extract selector-driven lifecycle without weakening DeepSeek**

Move generic `sendPrompt/watchResponse` mechanics into `SelectorAdapter`. It retains the existing 32 KiB delta, 512 KiB response, 90-second controller timeout and exact-one selection behavior. Keep DeepSeek exports compatible by constructing it with its existing selectors.

- [ ] **Step 4: Implement provider contracts and registry**

Use semantic ARIA/data-testid selectors first and structural fallbacks second. Each adapter has composer region, composer, send, assistant list, assistant and stop selectors. `index.ts` creates no controller if `adapterForOrigin(location.origin, document)` returns null.

- [ ] **Step 5: Run all content tests**

Run: `npm run test:run -- tests/unit/content`

Expected: PASS, including existing DeepSeek behavior.

- [ ] **Step 6: Commit**

```bash
git add src/content tests/fixtures tests/unit/content
git commit -m "feat: add qwen google ai studio and chatgpt adapters"
```

### Task 3: Surface provider identity and release documentation

**Files:**
- Modify: `src/types/protocol.ts`, `src/background/port-router.ts`, `src/sidepanel/tab-client.ts`, `src/sidepanel/App.vue`
- Modify: `tests/unit/background-router.test.ts`, `tests/unit/sidepanel.test.ts`, `tests/e2e/extension.spec.ts`
- Modify: `README.md`, `docs/security.md`

**Interfaces:** Connected-tab list has `provider: 'DeepSeek' | 'Qwen' | 'Google AI Studio' | 'ChatGPT'` derived by background from a trusted origin, never supplied by page content.

- [ ] **Step 1: Write failing provider-label tests**

```ts
expect(await client.listConnectedTabs()).toEqual([{ id: 8, title: 'ChatGPT', provider: 'ChatGPT' }]);
expect(screen.getByText('ChatGPT 页面')).toBeTruthy();
```

- [ ] **Step 2: Run focused tests to verify red**

Run: `npm run test:run -- tests/unit/background-router.test.ts tests/unit/sidepanel.test.ts`

Expected: FAIL because connected tabs have no trusted provider field.

- [ ] **Step 3: Implement trusted label propagation**

Map origin to provider only inside background, validate it in protocol, display it in the selection control, and never expose page-provided URLs or HTML.

- [ ] **Step 4: Update docs and E2E**

Document exact domains, the ordinary-message limitation for provider system prompts, and fail-closed DOM contracts. E2E verifies built-extension initial safety and scoped host permissions.

- [ ] **Step 5: Run release verification**

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/protocol.ts src/background/port-router.ts src/sidepanel tests README.md docs
git commit -m "docs: expose supported chat providers"
```

## Self-review

- Exact origin checks, manifest scopes, DOM adapter selection, provider labels and docs each have a dedicated task.
- No task grants wildcard host permissions or provider-native system-prompt modification.
- Each implementation task starts with a behavior test and ends with a scoped verification command and commit.
