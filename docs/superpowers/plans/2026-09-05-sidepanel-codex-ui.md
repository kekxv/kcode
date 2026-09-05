# kcode Side Panel Codex UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the kcode side panel into a compact Codex-inspired chat surface while retaining every existing workspace, risk, network, VM, tool-review, recovery, and history capability.

**Architecture:** Keep orchestration and permission code in `App.vue`; replace its flat control layout with a header, compact session context, conversational activity feed, bottom composer, and modal settings panel. Add a small theme-preference store backed by extension storage; CSS variables apply the active light/dark tokens while a media-query listener keeps the system setting live.

**Tech Stack:** Vue 3, TypeScript, Chrome extension storage, Vitest/jsdom, Playwright, CSS custom properties.

**Spec:** `design/kcode-sidepanel-concept.html`

## Global Constraints

- Preserve existing capability checks, risk confirmations, transaction review, result-release confirmation, recovery, `.session` history, relay, and VM-memory behavior.
- Default theme is `system`; it follows `prefers-color-scheme` without reopening the panel.
- Theme preference accepts only `system`, `light`, and `dark`.
- Default surface must remain usable at Chrome Side Panel widths down to 320 px.
- No new host permissions or content-script origins.

---

### Task 1: Persisted live theme preference

**Files:**
- Create: `src/sidepanel/theme-settings.ts`
- Create: `tests/unit/theme-settings.test.ts`
- Modify: `src/sidepanel/main.ts`
- Modify: `src/sidepanel/App.vue`

**Interfaces:**
- Produces `ThemeMode = 'system' | 'light' | 'dark'` and `ThemeSettingsStore.load(): Promise<ThemeMode>`, `save(mode): Promise<ThemeMode>`.
- `App.vue` receives `themeSettings` with `load` and `save` in `SidePanelServices`.

- [ ] **Step 1: Write the failing storage validation test**

```ts
it('falls back to system for an invalid persisted theme', async () => {
  const store = new ThemeSettingsStore({ get: async () => ({ 'kcode.theme': 'violet' }), set: async () => undefined });
  await expect(store.load()).resolves.toBe('system');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/theme-settings.test.ts`

Expected: FAIL because `ThemeSettingsStore` does not exist.

- [ ] **Step 3: Implement the minimal storage contract**

```ts
export type ThemeMode = 'system' | 'light' | 'dark';
const valid = (value: unknown): value is ThemeMode => value === 'system' || value === 'light' || value === 'dark';
```

Use `chrome.storage.sync` with key `kcode.theme`; malformed/missing values return `system`.

- [ ] **Step 4: Add a live effective-theme test**

```ts
it('uses the media query only in system mode', () => {
  expect(effectiveTheme('system', true)).toBe('dark');
  expect(effectiveTheme('light', true)).toBe('light');
});
```

- [ ] **Step 5: Implement and bind effective theme**

Expose `effectiveTheme(mode, systemDark)`; in `App.vue`, listen to `matchMedia('(prefers-color-scheme: dark)')`, put the active token on `<main data-theme>`, and save the selected preference from the settings panel.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- --run tests/unit/theme-settings.test.ts && npm run typecheck`

Commit: `git add src/sidepanel/theme-settings.ts src/sidepanel/main.ts src/sidepanel/App.vue tests/unit/theme-settings.test.ts && git commit -m "feat: add side panel theme settings"`

### Task 2: Codex-style shell and consolidated settings

**Files:**
- Modify: `src/sidepanel/App.vue`
- Modify: `src/sidepanel/styles.css`
- Modify: `src/sidepanel/components/StatusBar.vue`
- Modify: `src/sidepanel/components/TaskComposer.vue`
- Modify: `src/sidepanel/components/ChatFeed.vue`
- Create: `src/sidepanel/components/SessionSettings.vue`
- Create: `tests/unit/session-settings.test.ts`

**Interfaces:**
- `SessionSettings` takes theme state plus existing memory, auto, network, relay, instructions, history, and workspace callbacks.
- The existing approval components stay rendered above the composer and retain their event contracts.

- [ ] **Step 1: Write a failing settings accessibility test**

```ts
it('keeps advanced controls out of the default conversation surface', () => {
  render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
  expect(screen.getByRole('button', { name: '会话设置' })).toBeVisible();
  expect(screen.queryByLabelText('WISP 中继设置')).not.toBeVisible();
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm test -- --run tests/unit/sidepanel.test.ts tests/unit/session-settings.test.ts`

Expected: FAIL because the old flat settings layout is still visible.

- [ ] **Step 3: Implement the shell**

Add a 56 px header, context pills for page/workspace/execution, scrollable feed, and fixed composer. Render NetworkSettings, AgentSettings, memory selection, auto/network toggles, history controls, tab choice, and theme control inside `SessionSettings` dialog. Keep every existing event handler intact.

- [ ] **Step 4: Implement responsive tokens and light/dark styling**

Replace the flat stylesheet with semantic variables for `--bg`, `--surface`, `--soft`, `--line`, `--ink`, `--muted`, `--accent`, `--success`, and `--danger`; define both `[data-theme='light']` and `[data-theme='dark']`. Ensure focus rings and text contrast meet normal readability.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- --run tests/unit/sidepanel.test.ts tests/unit/session-settings.test.ts && npm run typecheck`

Commit: `git add src/sidepanel/App.vue src/sidepanel/styles.css src/sidepanel/components tests/unit && git commit -m "feat: redesign side panel conversation UI"`

### Task 3: Tool activity and visual regression coverage

**Files:**
- Modify: `src/sidepanel/components/ChatFeed.vue`
- Modify: `src/sidepanel/components/ToolApproval.vue`
- Modify: `src/sidepanel/components/ChangeReview.vue`
- Modify: `src/sidepanel/components/ResultRelease.vue`
- Modify: `tests/e2e/extension.spec.ts`

**Interfaces:**
- Existing `approve-tool`, `reject`, `accept`, `rollback`, `release`, and `cancel` emissions stay unchanged.

- [ ] **Step 1: Write a failing activity-card test**

```ts
it('labels a pending tool operation and leaves both decisions available', () => {
  render(ToolApproval, { props: { call, workspaceName: 'project', network: 'offline' } });
  expect(screen.getByText(/等待批准/)).toBeVisible();
  expect(screen.getByRole('button', { name: '运行工具' })).toBeVisible();
  expect(screen.getByRole('button', { name: '拒绝' })).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm test -- --run tests/unit/sidepanel.test.ts`

Expected: FAIL until the activity card label is rendered.

- [ ] **Step 3: Implement compact activity cards**

Make tool, change, and release controls card-like and visually distinguish pending, safe-success, and dangerous operations while retaining full path, byte, and result information.

- [ ] **Step 4: Extend packaged UI test**

Assert the packaged panel exposes `会话设置`, `给 kcode 一项任务`, and the default system theme token without requiring a directory or chat tab.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

Commit: `git add src/sidepanel/components tests/unit tests/e2e && git commit -m "test: cover side panel activity UI"`
