import { describe, expect, it, vi } from 'vitest';
import { ToolDispatcher } from '../../src/sidepanel/tool-dispatcher';

const workspace = { workspaceId: 'workspace-1', handle: { kind: 'directory' } as FileSystemDirectoryHandle, network: { mode: 'wisp' as const, relayUrl: 'wss://relay.example/wisp' }, memoryProfile: 'standard' as const };

const vm = () => ({
  start: vi.fn(async () => undefined), attachWorkspace: vi.fn(async () => undefined), beginTransaction: vi.fn(async () => undefined),
  exec: vi.fn(async () => ({ output: 'ok', exitCode: 0, truncated: false, durationMs: 1, transactionId: 'no_transaction', journalSummary: { transactionId: 'no_transaction', state: 'clean' as const, entries: [], journalBytes: 0, writtenBytes: 0 } })),
  readFile: vi.fn(), writeFile: vi.fn(), commitTransaction: vi.fn(), rollbackTransaction: vi.fn(), terminate: vi.fn(),
});

describe('network egress authority', () => {
  it('does not construct a networked Worker without exact workspace-networked consent', async () => {
    // Break caught: a checked UI toggle or model-supplied relay URL must not be sufficient authority to create the WISP WebSocket.
    const runtime = vm();
    const authorizeNetwork = vi.fn(async () => false);
    const dispatcher = new ToolDispatcher(runtime, async () => workspace, authorizeNetwork);
    await expect(dispatcher.execute({ id: 'x', tool: 'bash', args: { cmd: 'curl https://example.com', workspace: 'read' } }, { source: 'interactive', capabilities: ['read'] }, new AbortController().signal)).rejects.toThrow('NETWORK_CONSENT_REQUIRED');
    expect(authorizeNetwork).toHaveBeenCalledWith({ workspaceId: 'workspace-1', relayUrl: 'wss://relay.example/wisp' });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('revalidates the exact normalized relay immediately before each networked VM start', async () => {
    // Break caught: consent for one relay path must not authorize another endpoint on the same origin.
    const runtime = vm();
    const authorizeNetwork = vi.fn(async (context: { relayUrl: string | null }) => context.relayUrl === 'wss://relay.example/wisp');
    const dispatcher = new ToolDispatcher(runtime, async () => workspace, authorizeNetwork);
    await dispatcher.execute({ id: 'x', tool: 'bash', args: { cmd: 'curl https://example.com', workspace: 'read' } }, { source: 'interactive', capabilities: ['read'] }, new AbortController().signal);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ network: { mode: 'wisp', relayUrl: 'wss://relay.example/wisp' } }), 'standard');
  });
});
