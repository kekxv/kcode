# Threat model

## Trust zones

The **DeepSeek page/model**, **selected repository**, **guest root**, and **WISP relay** are hostile. The **content script**, **background**, **Side Panel**, and **9P/FSA capability** are distinct extension trust zones and capability boundaries; data crossing between them must be validated and explicitly authorized.

## Release-blocking security invariants

1. `WorkspaceSession` has independent offline/WISP network state; directory handles travel only through `VM_ATTACH_WORKSPACE`, never Chrome Ports or persistent configuration, and WISP requires a validated relay URL plus matching `workspace-networked` consent.
2. Background accepts only this extension's Side Panel and DeepSeek top-level frame; tab identity comes from `port.sender.tab.id`, never page-supplied identity fields.
3. A VM with a directory handle remains read-only unless the active approved transaction grants the relevant `write` or `delete` capability.
4. Shell serial nonces frame output only; the Side Panel watchdog destroys the Dedicated Worker to terminate work.
5. AI responses, commands, file contents, and terminal output render as plain text only: no `v-html`, remote resources, OSC 52, OSC 8, or window-title control sequences.
6. Tool results remain local until scanned, redacted, and truncated; `confirm-each` requires preview approval and `auto` can send only the processed payload, never detected raw secrets.
7. Only a Side Panel user gesture may grant `RiskConsent`, stored in `chrome.storage.session`; each step rechecks its version, workspace ID, normalized full relay URL, and execution mode, otherwise it fails closed to `confirm-each`/`offline` and stops.
8. Timeout, Port disconnect, navigation, Worker crash, incomplete journal, budget breach, or user stop always fail closed: stop, destroy the VM, do not send further data, and offer recovery or rollback.

## Relay boundary

`connect-src wss:` is intentionally broad so a user can configure a WISP relay at runtime. This expands the extension's potential egress surface: only `network-config.ts` may construct a WebSocket relay URL, and it must strictly validate that URL before use.
