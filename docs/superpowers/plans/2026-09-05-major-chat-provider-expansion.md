# Major Chat Provider Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude, Gemini, Microsoft Copilot, and Perplexity as explicit web-chat providers.

**Architecture:** Add one exact content-script origin and one dedicated adapter per provider. Preserve the existing design: unsupported or ambiguous DOM controls fail closed, and broad host permission never enables arbitrary-site content-script injection.

**Tech Stack:** Manifest V3, TypeScript, Vue, Vitest, Playwright.

**Spec:** `README.md` and `src/content/adapters/base.ts`.

## Global Constraints

- Content-script matches are limited to `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, and `www.perplexity.ai`.
- No cookies, credentials, system prompts, generic page selectors, or automatic send actions.
- Observe current public DOM controls before committing selectors; add tests first.

### Task 1: Register provider identities and origins

**Files:** `src/types/protocol.ts`, `manifest.json`, `scripts/security-source-scan.mjs`, `tests/e2e/extension.spec.ts`

- [ ] Write a failing packaging assertion:

```ts
expect(matches).toEqual(expect.arrayContaining([
  'https://claude.ai/*', 'https://gemini.google.com/*',
  'https://copilot.microsoft.com/*', 'https://www.perplexity.ai/*',
]));
```

- [ ] Run `npm run test:e2e -- --grep "supported chat origins"`; it must fail before implementation.
- [ ] Add the four exact matches, provider-union members, and matching source-scan allowlist entries.
- [ ] Re-run the test and commit with `feat: register major chat provider origins`.

### Task 2: Add fail-closed provider adapters

**Files:** `src/content/adapters/{claude,gemini,copilot,perplexity}.ts`, `src/content/adapters/registry.ts`, `tests/unit/adapter-registry.test.ts`

- [ ] Write a failing registry test which expects each exact origin to return its provider and `https://evil.example` to return `null`.
- [ ] Run `npm run test:run -- tests/unit/adapter-registry.test.ts`; it must fail because mappings do not exist.
- [ ] Implement each `SelectorAdapter` with selectors verified from the provider's public DOM; require one composer and one explicit submit control in its form region.
- [ ] Register only the exact origins and rerun unit tests.
- [ ] Commit with `feat: add major chat site adapters`.

### Task 3: Document and release-test

**Files:** `README.md`, `tests/e2e/extension.spec.ts`

- [ ] Add the four HTTPS sites to README's support list and state that login/account requirements remain provider-controlled.
- [ ] Run `npm run verify`; it must pass source scanning, audit, types, all tests, VM asset checks, build, distribution scanning, E2E, and SBOM.
- [ ] Commit verified changes and fast-forward merge to `main`.

## Self-Review

- Every provider has matching type, origin, adapter, registry, test, and README entry.
- No content script runs on an origin outside the nine supported chat sites.
- Each new adapter fails instead of guessing when public DOM structure changes.
