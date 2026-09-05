# Architecture

The Side Panel owns user gesture, risk consent, task state and review UI. Its `AgentOrchestrator` sends prompts through an authenticated Background Port to the DeepSeek content adapter. Model text is untrusted and can only become a strict single tool call after parsing.

Each tool starts a new Dedicated Worker. The Worker starts v86, attaches the selected File System Access directory through 9P at `/work`, and applies the approved read/write/delete policy. Mutations create an OPFS journal before changing the host directory. The Side Panel either commits or rolls it back; timeout, cancel and Worker failures terminate the VM fail-closed.

For offline work the VM has no NIC. For a valid, session-consented WISP configuration, the Worker validates the exact saved `wss://` relay again and passes the translated `wisps://` URL to v86's virtio network device. The same VM still mounts `/work`; network consent never broadens 9P capabilities.

Before a result returns to the page, `ResultGuard` scans, redacts, visualizes control characters and truncates it. `confirm-each` requires release approval. `auto` sends only this processed representation, never raw findings.
