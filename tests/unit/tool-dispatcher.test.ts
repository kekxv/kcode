import { describe, expect, it, vi } from 'vitest';
import { ToolDispatcher } from '../../src/sidepanel/tool-dispatcher';

const workspace = { workspaceId: 'workspace-1', handle: { kind: 'directory' } as FileSystemDirectoryHandle, network: { mode: 'offline' as const }, memoryProfile: 'standard' as const };
const vm = () => {
  let transactionId = 'no_transaction';
  const summary = (state: 'clean' | 'dirty') => ({ transactionId, state, entries: [], journalBytes: 0, writtenBytes: state === 'dirty' ? 1 : 0 });
  return {
    start: vi.fn(async () => undefined),
    attachWorkspace: vi.fn(async () => undefined),
    beginTransaction: vi.fn(async (next: string) => { transactionId = next; }),
    exec: vi.fn(async () => ({ output: 'ok', exitCode: 0, truncated: false, durationMs: 1, transactionId, journalSummary: summary('clean') })),
    readFile: vi.fn(async () => ({ text: 'file', transactionId, journalSummary: summary('clean') })),
    writeFile: vi.fn(async () => ({ text: '', transactionId, journalSummary: summary('dirty') })),
    commitTransaction: vi.fn(async () => undefined),
    rollbackTransaction: vi.fn(async () => undefined),
    terminate: vi.fn(),
  };
};

describe('ToolDispatcher', () => {
  it('boots a disposable /work VM with only the parsed capability', async () => {
    const runtime = vm();
    const dispatcher = new ToolDispatcher(runtime, async () => workspace);
    await dispatcher.execute({ id: 'x', tool: 'bash', args: { cmd: 'find .', workspace: 'read', timeoutMs: 4_000 } }, { source: 'interactive', capabilities: ['read'] }, new AbortController().signal);
    expect(runtime.start).toHaveBeenCalledWith({ mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read'], network: { mode: 'offline' } }, 'standard');
    expect(runtime.attachWorkspace).toHaveBeenCalledWith(workspace.handle);
    expect(runtime.exec).toHaveBeenCalledWith("cd /work && find .", { timeoutMs: 4_000 });
  });

  it('uses confined file RPCs so path and content never become shell syntax', async () => {
    const runtime = vm();
    const dispatcher = new ToolDispatcher(runtime, async () => workspace);
    await dispatcher.execute({ id: 'x', tool: 'write_file', args: { path: "a'b.txt", content: '$(id)\ntext' } }, { source: 'interactive', capabilities: ['write'] }, new AbortController().signal);
    expect(runtime.writeFile).toHaveBeenCalledWith("a'b.txt", '$(id)\ntext');
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it('rejects broadened or mismatched authorization before starting a Worker', async () => {
    const runtime = vm();
    const dispatcher = new ToolDispatcher(runtime, async () => workspace);
    await expect(dispatcher.execute({ id: 'x', tool: 'read_file', args: { path: 'a.txt' } }, { source: 'interactive', capabilities: ['read', 'write'] }, new AbortController().signal)).rejects.toThrow('TOOL_AUTHORIZATION_INVALID');
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('rolls back the active transaction on abort after execution', async () => {
    const runtime = vm();
    const dispatcher = new ToolDispatcher(runtime, async () => workspace);
    const execution = await dispatcher.execute({ id: 'x', tool: 'bash', args: { cmd: 'touch a', workspace: 'write' } }, { source: 'interactive', capabilities: ['write'] }, new AbortController().signal);
    await dispatcher.abort('USER_STOP');
    expect(runtime.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(execution.transactionId).toMatch(/^tx_[A-Za-z0-9_]+$/);
  });
});
