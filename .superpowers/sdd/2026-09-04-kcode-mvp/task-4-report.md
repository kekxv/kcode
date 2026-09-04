# Task 4 Report — Side Panel shell and session-risk boundary

## Delivered

- A compact Vue Side Panel with status bar, independently scrollable chat and terminal panes, multiline task composer, persistent one-click stop, high-risk red status, and plain-text approval/review/release components.
- `TabClient` uses the authenticated background Port only. The router now exposes connected DeepSeek content ports through a request-correlated list command; it never calls `chrome.tabs.query` and no manifest permission changed.
- `VMClient` provides correlated init/attach/exec RPC, bounded output-delta subscriptions, worker crash rejection, synchronous termination, handle clearing, and disposal. The required worker entry is an explicit fail-closed `VM_RUNTIME_UNAVAILABLE` shell pending Task 5; it contains no VM, network, or agent behavior.
- `RiskConsentStore` stores only versioned records in `chrome.storage.session`, checks active user activation before its first await, normalizes complete WSS relay URLs, validates exact requested modes, verifies a combined write, and removes all tentative records on failure. It re-reads storage for every validity check, so explicit revocation/session loss/context mismatch fails closed.
- Terminal text is streamed through an SGR-only escape sanitizer. OSC 8/52/title, DCS, APC, PM and non-SGR controls are stripped; visible-command rendering converts bidi, zero-width, NUL, and unsafe C0/C1 controls into `U+XXXX` text.

## TDD evidence

The initial required focused command was run before implementation and failed because all five requested modules/components were absent. Subsequent red/green cycles covered the sanitizer, terminal batching/disposal, VM correlation/crash/termination, consent validation/atomicity/session loss, authenticated tab listing, and Side Panel consent gating.

## Verification

- `npm run test:run -- tests/unit/sidepanel.test.ts tests/unit/vm-client.test.ts tests/unit/risk-consent.test.ts tests/unit/untrusted-text.test.ts tests/security/risk-consent.test.ts` — 15 passing tests.
- `npm run test:run` — 12 files, 78 passing tests.
- `npm run typecheck` — passed.
- `npx vite build` — passed.
- `git diff --check` — passed.

## Known concern

`npm run build` still stops before Vite at the pre-existing missing `scripts/verify-vm-assets.mjs` task from the VM-assets milestone. The task-local `npx vite build` succeeds after adding the deliberately fail-closed worker entry. Vite also reports its existing future `configLoader: native` JSON-import warning.

## Fix round 1 — P1 regressions

Four new tests were added and run RED against commit `dd6ad8c` before production changes:

- A live WISP relay URL path change left `networkMode` active and did not terminate/revoke.
- `TerminalPane` did not provide a delta-only delivery path for accumulated terminal chunks.
- BEL, backspace, tab, IND, and RI survived terminal sanitization.
- A thrown `VM_ATTACH_WORKSPACE` post rejected only that promise while retaining the worker boundary.

GREEN changes wire the relay input to compare the normalized complete URL during active WISP use and call `stopAndRevoke('RELAY_URL_CHANGED')`; track a terminal delivery cursor so only appended chunks are passed to `TerminalManager`; allow only printable text, CR/LF, and approved SGR through the sanitizer; and terminate/clear every VM pending boundary after an attach post failure. Focused regression tests passed after the changes.

## Fix round 2 — 8-bit terminal string controls

The new sanitizer regression was run RED with 8-bit OSC (`\u009d2;title\u0007`), DCS (`\u0090secret\u001b\\`), APC, and PM. The old parser removed only their C1 introducers and leaked the payload text. GREEN routes C1 OSC/DCS/APC/PM introducers into the existing stateful string-removal state, using BEL or ST termination just like the ESC-prefixed forms. Approved SGR and printable/CR/LF behavior remain covered by the existing tests.
