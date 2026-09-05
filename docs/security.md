# Security model

The manifest has only `sidePanel` and `storage`, and is scoped to `https://chat.deepseek.com/*`. Extension pages deliberately allow `connect-src wss:` for WISP, but relay URLs are accepted only from a Side Panel gesture, strictly validated, normalized and stored in trusted `chrome.storage.local`. Risk consent is session-only and tied to workspace, exact relay URL and consent schema.

Credential-like paths such as `.env`, private keys and package-manager credentials are denied by the 9P/FSA boundary. A journal records every allowed mutation before it is applied; conflicts stop automatic recovery instead of overwriting host edits. Output limits, watchdogs, cancellation and native Worker termination are fail-closed.

`auto + networked /work` is intentionally high risk: model-selected commands may modify/delete selected files and can upload other readable data inside TLS without result DLP. Successful auto journal commits are not reversible by the Stop control. A WISP relay can observe destination metadata and plaintext protocols, and DeepSeek prompts/results follow the user's DeepSeek account privacy and retention policy. The warning is informed consent for these residual risks, not a sandbox guarantee.
