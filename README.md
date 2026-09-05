# kcode

kcode is a Chrome MV3 side-panel extension that lets a logged-in DeepSeek page request bounded tools in a disposable v86 Alpine VM. The selected directory is mounted only at `/work` through 9P; every VM is destroyed after one tool call.

## Prerequisites

- Node.js 22.12 or newer
- Chrome 116 or newer
- Docker or Podman only when rebuilding the guest assets
- A user-operated or trusted `wss://` WISP relay for optional guest networking

## Build and load

```sh
npm ci
npm run assets:verify
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, then select `dist/`. Open `https://chat.deepseek.com/`, log in, and open the kcode side panel from the extension action.

Choose a directory first. kcode initially requests read permission only. Use the visible high-risk dialog before Auto or WISP networking. `confirm-each` requires separate approval for the tool, file changes, and processed result. `auto` intentionally skips those routine approvals for the current browser session after the warning; Stop immediately revokes it.

## WISP relay

Save a strict `wss://host/path` URL in the side panel before enabling networking. URLs with credentials, query strings, fragments, whitespace, `ws:`, or traversal encodings are rejected. The saved URL is not consent: selecting networking still requires a session-only confirmation tied to the exact workspace and URL.

WISP provides relay-policy-dependent guest outbound TCP for typical DNS/HTTPS/Git/NPM flows. It does not provide raw IP, arbitrary UDP, inbound ports, anonymity, or a trusted relay. A networked guest can upload readable non-protected `/work` data inside TLS without passing through result redaction.

## Checks

```sh
npm run test:run
npm run typecheck
npm run security:source
npm run build
npm run security:dist
npm run sbom
```

`npm run verify` runs the release sequence including Playwright. The live WISP test is opt-in and needs `KCODE_WISP_TEST_URL` plus `KCODE_WISP_PROBE_URL` for an operator-controlled relay/probe.

## Limits

The MVP supports normal files/directories, bounded reads/writes/deletes, non-atomic recoverable rename, a 20-turn task maximum, and one VM per tool call. Symbolic links, hard links, device files, raw networking and reliable physical erasure are out of scope.
