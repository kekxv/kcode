# kcode

kcode is a Chrome MV3 side-panel extension that lets a logged-in chat page request bounded tools in a disposable v86 Alpine VM. It supports DeepSeek, Qwen, Google AI Studio, ChatGPT, and HIX.AI. The selected directory is mounted only at `/work` through 9P; every VM is destroyed after one tool call.

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

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, then select `dist/`. Open and log in to one supported page, then open the kcode side panel from the extension action:

- `https://chat.deepseek.com/`
- `https://chat.qwen.ai/`
- `https://aistudio.google.com/`
- `https://chatgpt.com/`
- `https://hix.ai/ai-chat`

The extension requests broad host access so its approved network tools can work across sites, but content scripts still run only on the listed chat sites. The extension does not set or modify a provider-native system prompt. Its optional custom Agent instructions are appended to the first kcode-controlled ordinary user message, after the fixed safety policy, so they cannot weaken workspace, approval, or network controls. Provider UI changes or ambiguous page controls stop the request with an adapter error instead of choosing a control heuristically.

Choose a directory first. kcode initially requests read permission only. Use the visible high-risk dialog before Auto or WISP networking. `confirm-each` requires separate approval for the tool, file changes, and processed result. `auto` intentionally skips those routine approvals for the current browser session after the warning; Stop immediately revokes it.

## WISP relay

Save a strict `wss://host/path` URL in the side panel before enabling networking. URLs with credentials, query strings, fragments, whitespace, `ws:`, or traversal encodings are rejected. The saved URL is not consent: selecting networking still requires a session-only confirmation tied to the exact workspace and URL.

WISP provides relay-policy-dependent guest outbound TCP for typical DNS/HTTPS/Git/NPM flows. It does not provide raw IP, arbitrary UDP, inbound ports, anonymity, or a trusted relay. A networked guest can upload readable non-protected `/work` data inside TLS without passing through result redaction.

### Obtaining a relay

The extension does not operate a public relay. Use a relay you control or that your team operates, and enter its public WebSocket URL such as `wss://relay.example.com/wisp`.

For a small Docker deployment, run a WISP-protocol-compatible TCP-over-WebSocket relay on a VPS, NAS, or internal server and place it behind a TLS reverse proxy such as Caddy, Nginx, or Traefik. The relay must be reachable through `wss://`; plain `ws://` and ordinary HTTP/SOCKS proxy URLs are rejected. Restrict destinations and ports at the relay/firewall level, disable private and loopback destination access, and protect the endpoint with your normal access controls.

Cloudflare can provide the TLS/WebSocket edge for a relay endpoint. Whether it can also terminate the TCP relay depends on the Worker/Sockets features and egress policy available to your Cloudflare account. A compatible deployment still needs to expose a WISP WebSocket endpoint; an ordinary Cloudflare HTTP proxy URL is not sufficient.

### Fetch fallback

The Agent may use a `fetch` tool call for HTTPS retrieval. It runs as a bounded `curl` command inside the disposable VM, requires enabled WISP networking and the existing risk confirmation, and is shown for approval in `confirm-each` mode. It is not an unrestricted browser-page fetch bridge.

### Local work history

After workspace write permission is granted, completed tasks are recorded in `.session/kcode-history.sqlite` inside the selected directory. `.session/` is ignored by this repository's Git configuration. Use **清除工作记录** in the Side Panel to remove the SQLite history file.

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
