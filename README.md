# kcode

kcode is a Chrome MV3 side-panel extension that lets a logged-in chat page request bounded tools in a persistent v86 Alpine VM. It supports DeepSeek, Qwen, Google AI Studio, ChatGPT, and HIX.AI. The selected directory is mounted only at `/work` through 9P; the side panel reuses the VM and shell cwd/environment between tools in the same workspace and network configuration. Stop, timeout, or a workspace/network/memory change destroys the VM.

[中文说明](README.zh-CN.md)

## Example output

The [`assets/`](assets/) folder holds an end-to-end demonstration produced with kcode: a modern, minimal Gomoku (五子棋) game that the page AI built on request, together with a screenshot taken once the task finished.

- [`assets/index.html`](assets/index.html) — a self-contained Gomoku game. Open it directly in a browser to play against the built-in AI. It includes a wood-grain board, realistic pieces, move undo, an AI opening move, and per-browser win/streak statistics.
- [`assets/SCR-20260907-jsyu.png`](assets/SCR-20260907-jsyu.png) — a screenshot of the kcode side panel next to Google AI Studio, showing the completed task and its reviewed result.

## Prerequisites

- Node.js 22.12 or newer
- Chrome 116 or newer
- Docker or Podman only when rebuilding the guest assets
- A user-operated or trusted `wss://` WISP relay for optional guest networking

## Build and load

```sh
npm ci
npm run build
```

This uses the checked-in, hash-verified VM assets in `public/v86/`; Docker is
not required. To verify those files explicitly, run `npm run assets:verify`.

### Regenerate VM assets (maintainers only)

Use this path only when intentionally changing the guest image or pinned v86
assets. It requires Docker or a Podman setup that provides a compatible
`docker` CLI, and replaces the checked-in kernel/initramfs assets:

```sh
npm ci
npm run assets:rebuild
```

`assets:rebuild` performs Docker-based guest construction followed by deep
initramfs/rootfs inspection. CI runs the same deep inspection; ordinary builds
and `npm run verify` only validate the shipped asset manifest, hashes and size
limits.

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, then select `dist/`. Open and log in to one supported page, then open the kcode side panel from the extension action:

- `https://chat.deepseek.com/`
- `https://chat.qwen.ai/`
- `https://aistudio.google.com/`
- `https://chatgpt.com/`
- `https://hix.ai/ai-chat`
- `https://gemini.google.com/`

The extension requests broad host access so its approved network tools can work across sites, but content scripts still run only on the listed chat sites. The extension does not set or modify a provider-native system prompt. Its optional custom Agent instructions are appended to the first kcode-controlled ordinary user message, after the fixed safety policy, so they cannot weaken workspace, approval, or network controls. Provider UI changes or ambiguous page controls stop the request with an adapter error instead of choosing a control heuristically.

Choose a directory first. kcode initially requests read permission only. The header provides Manual, Auto-write, and Full-auto. Manual approves tools, changes, and processed results separately. Auto-write automates file reads/writes, commits, and redacted result release, while shell tools still require approval. Full-auto skips these routine approvals. Selecting an automatic mode grants session authority for the selected directory; Stop revokes it. WISP networking retains its separate explicit confirmation.

## WISP relay

Save a strict `wss://host/path` URL in the side panel before enabling networking. URLs with credentials, query strings, fragments, whitespace, `ws:`, or traversal encodings are rejected. The saved URL is not consent: selecting networking still requires a session-only confirmation tied to the exact workspace and URL.

WISP provides relay-policy-dependent guest outbound TCP for typical DNS/HTTPS/Git/NPM flows. It does not provide raw IP, arbitrary UDP, inbound ports, anonymity, or a trusted relay. A networked guest can upload readable non-protected `/work` data inside TLS without passing through result redaction.

### Obtaining a relay

The extension does not operate a public relay. Use a relay you control or that your team operates, and enter its public WebSocket URL such as `wss://relay.example.com/wisp`.

For a small Docker deployment, this repository includes a restricted relay template in `deploy/wisp/`: it permits only outbound TCP to ports 80, 443, 9418, and 22; rejects direct-IP, private, and loopback targets; disables UDP; and caps concurrent streams. Point a public DNS name at the host, then run:

```sh
cd deploy/wisp
cp .env.example .env
# Set WISP_DOMAIN to the public DNS name in .env.
docker compose up -d --build
```

Enter `wss://your-domain/` in the Side Panel. Caddy obtains and renews the TLS certificate, so inbound ports 80 and 443 must reach the host. The Docker image installs the third-party `@mercuryworkshop/wisp-js` relay at build time; it is not bundled into the extension. Review its upstream licensing before redistributing a built image.

Cloudflare can provide the TLS/WebSocket edge for a relay endpoint. Whether it can also terminate the TCP relay depends on the Worker/Sockets features and egress policy available to your Cloudflare account. A compatible deployment still needs to expose a WISP WebSocket endpoint; an ordinary Cloudflare HTTP proxy URL is not sufficient.

### Fetch fallback

The Agent may use a `fetch` tool call for HTTPS retrieval. It runs as a bounded `curl` command inside the disposable VM, requires enabled WISP networking and the existing risk confirmation, and is shown for approval in `confirm-each` mode. It is not an unrestricted browser-page fetch bridge.

### Local work history

Use **启用工作记录（写入 .session）** to explicitly grant optional history writing. Completed tasks are then stored, after the same secret redaction and size bound used for tool results, in `.session/kcode-history.sqlite` inside the selected directory. Opening the Side Panel never creates this folder or database. `.session/` is ignored by this repository's Git configuration. Use **清除工作记录** to remove the SQLite history file.

### Restart recovery

When optional `.session` writing is enabled, kcode saves a redacted checkpoint before each task starts. After a browser or Side Panel restart, an interrupted checkpoint is shown as **恢复上次任务**. It never sends automatically: select the matching provider page and click **恢复任务**. The restored prompt includes the original task and its last saved summary, and instructs the page AI to inspect `/work` before continuing. Auto mode, WISP networking, VM processes, pending tool approvals, and uncommitted transactions are deliberately not restored; their consent and review boundaries start fresh.

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

## VM boot state

The repository ships only the verified kernel, firmware, initramfs, and v86
runtime required for a cold boot. Its root image is embedded in the initramfs,
not duplicated as a standalone package asset. It never ships a prebuilt VM state.
After a user's first offline boot is ready (before any workspace is mounted),
the extension may save a local browser snapshot for that same RAM profile.
These local states are not part of the extension package or Git history. WISP
networked boots always cold-boot, as do boots with another memory profile.

## Limits

The MVP supports normal files/directories, bounded reads/writes/deletes, non-atomic recoverable rename, a 20-turn task maximum, and one VM per tool call. Symbolic links, hard links, device files, raw networking and reliable physical erasure are out of scope.
