import { describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator } from '../../src/sidepanel/agent-orchestrator';
import type { GuardedResult, ToolAuthorization, ToolExecution } from '../../src/types/tools';

const context = { workspaceId: 'workspace-1', relayUrl: null };
const execution = (): ToolExecution => ({
  transactionId: 'tx_1',
  result: { text: 'token=AKIA1234567890ABCDEF', exitCode: 0, truncated: false, durationMs: 2 },
  journalSummary: { transactionId: 'tx_1', state: 'dirty', entries: [{ path: 'a.txt', operation: 'write', originalBytes: 0, resultingBytes: 1 }], journalBytes: 10, writtenBytes: 1 },
});

const setup = (answers: string[], validConsent = true) => {
  const tab = { sendPrompt: vi.fn(async (_tabId: number, _prompt: string, handlers?: { onDelta?: (text: string) => void; signal?: AbortSignal }) => { handlers?.onDelta?.(answers.shift() ?? 'done'); }) };
  const dispatcher = { execute: vi.fn(async () => execution()), resolveChanges: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
  const approvals = {
    requestTool: vi.fn(async (): Promise<ToolAuthorization | null> => ({ source: 'interactive', capabilities: ['write'] })),
    requestResultRelease: vi.fn(async (_guarded: GuardedResult) => true),
  };
  const changes = { review: vi.fn(async () => 'accept' as const) };
  const consents = { hasValid: vi.fn(async () => validConsent), revokeAll: vi.fn(async () => undefined) };
  const states: string[] = [];
  const orchestrator = new AgentOrchestrator({ tab, dispatcher, approvals, changes, consents, onState: (state) => states.push(state) });
  return { orchestrator, tab, dispatcher, approvals, changes, consents, states };
};

describe('AgentOrchestrator', () => {
  it('runs all three confirm-each gates and releases only the redacted result', async () => {
    const s = setup(['<tool_call>{"id":"x","tool":"write_file","args":{"path":"a.txt","content":"x"}}</tool_call>', 'finished']);
    const outcome = await s.orchestrator.run('update file', { tabId: 7, executionMode: 'confirm-each', consentContext: context });
    expect(outcome).toEqual({ state: 'completed', text: 'finished' });
    expect(s.approvals.requestTool).toHaveBeenCalledTimes(1);
    expect(s.changes.review).toHaveBeenCalledTimes(1);
    expect(s.approvals.requestResultRelease).toHaveBeenCalledTimes(1);
    expect(s.dispatcher.resolveChanges).toHaveBeenCalledWith('tx_1', 'accept', expect.any(AbortSignal));
    expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('[REDACTED:aws-access-key]');
    expect(s.tab.sendPrompt.mock.calls[1][1]).not.toContain('AKIA1234567890ABCDEF');
  });

  it('treats result release as approval only and cannot substitute raw text', async () => {
    // Break caught: a compromised UI callback must not replace the guard preview with a raw secret-bearing payload.
    const s = setup(['<tool_call>{"id":"x","tool":"write_file","args":{"path":"a.txt","content":"x"}}</tool_call>', 'finished']);
    s.approvals.requestResultRelease.mockResolvedValueOnce('AKIA1234567890ABCDEF' as unknown as boolean);
    await s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context });
    expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('[REDACTED:aws-access-key]');
    expect(s.tab.sendPrompt.mock.calls[1][1]).not.toContain('AKIA1234567890ABCDEF');
  });

  it('passes the root AbortSignal into the active page request', async () => {
    // Break caught: cancel changes local state while DeepSeek continues generating and its observer remains live.
    const s = setup([]);
    s.tab.sendPrompt.mockImplementationOnce((_tabId: number, _prompt: string, handlers?: { signal?: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      handlers?.signal?.addEventListener('abort', () => reject(new Error(String(handlers.signal?.reason))), { once: true });
    }));
    const pending = s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context });
    await vi.waitFor(() => expect(s.tab.sendPrompt).toHaveBeenCalledOnce());
    s.orchestrator.cancel('USER_STOP');
    await expect(pending).resolves.toEqual({ state: 'cancelled', code: 'USER_STOP' });
    expect(s.tab.sendPrompt.mock.calls[0][2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('auto revalidates consent at execution, commit, and release while skipping routine dialogs', async () => {
    const s = setup(['<tool_call>{"id":"x","tool":"bash","args":{"cmd":"pwd","workspace":"read"}}</tool_call>', 'finished']);
    const outcome = await s.orchestrator.run('show pwd', { tabId: 7, executionMode: 'auto', consentContext: context });
    expect(outcome.state).toBe('completed');
    expect(s.consents.hasValid.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(s.approvals.requestTool).not.toHaveBeenCalled();
    expect(s.changes.review).not.toHaveBeenCalled();
    expect(s.approvals.requestResultRelease).not.toHaveBeenCalled();
    expect(s.dispatcher.resolveChanges.mock.invocationCallOrder[0]).toBeLessThan(s.tab.sendPrompt.mock.invocationCallOrder[1]);
  });

  it('stops before executing when auto consent is absent', async () => {
    const s = setup([], false);
    await expect(s.orchestrator.run('goal', { tabId: 7, executionMode: 'auto', consentContext: context })).resolves.toEqual({ state: 'failed', code: 'AUTO_CONSENT_REQUIRED' });
    expect(s.dispatcher.execute).not.toHaveBeenCalled();
  });

  it('rejects an auto-consent authorization returned by the confirm-each approval gate', async () => {
    // Break caught: a compromised or stale approval UI can label a routine click as session-wide auto authority.
    const s = setup(['<tool_call>{"id":"x","tool":"bash","args":{"cmd":"pwd","workspace":"read"}}</tool_call>']);
    s.approvals.requestTool.mockResolvedValueOnce({ source: 'auto-consent', capabilities: ['read'] });

    await expect(s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context }))
      .resolves.toEqual({ state: 'failed', code: 'TOOL_AUTHORIZATION_SOURCE_INVALID' });
    expect(s.dispatcher.execute).not.toHaveBeenCalled();
  });

  it('rejects a repeated tool call ID before executing it twice', async () => {
    // Break caught: replayed model output can repeat a mutating call after its first journal has already committed.
    const repeated = '<tool_call>{"id":"same","tool":"write_file","args":{"path":"a.txt","content":"x"}}</tool_call>';
    const s = setup([repeated, repeated]);

    await expect(s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context }))
      .resolves.toEqual({ state: 'failed', code: 'DUPLICATE_TOOL_CALL_ID' });
    expect(s.dispatcher.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when DeepSeek completes without any response text', async () => {
    // Break caught: a detached observer or changed DOM is reported as a successful task with an empty answer.
    const s = setup(['']);

    await expect(s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context }))
      .resolves.toEqual({ state: 'failed', code: 'EMPTY_AI_RESPONSE' });
    expect(s.dispatcher.execute).not.toHaveBeenCalled();
  });

  it('states the current execution and network policy in the first model prompt', async () => {
    // Break caught: the model guesses stale auto/network availability and repeatedly requests invalid tools.
    const s = setup(['finished']);
    await s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context });

    expect(s.tab.sendPrompt.mock.calls[0][1]).toContain('Execution mode: confirm-each.');
    expect(s.tab.sendPrompt.mock.calls[0][1]).toContain('Network: offline.');
  });

  it('rolls back a dirty transaction after a result-release failure', async () => {
    const s = setup(['<tool_call>{"id":"x","tool":"write_file","args":{"path":"a.txt","content":"x"}}</tool_call>']);
    s.approvals.requestResultRelease.mockRejectedValueOnce(new Error('UI_DISMISSED'));
    const outcome = await s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context });
    expect(outcome).toMatchObject({ state: 'failed', code: 'UI_DISMISSED' });
    expect(s.dispatcher.resolveChanges).toHaveBeenCalledWith('tx_1', 'accept', expect.any(AbortSignal));
    expect(s.dispatcher.abort).toHaveBeenCalled();
  });

  it('enforces the twenty-turn limit and rejects concurrent runs', async () => {
    const calls = Array.from({ length: 20 }, (_, index) => `<tool_call>{"id":"x${index}","tool":"bash","args":{"cmd":"pwd","workspace":"read"}}</tool_call>`);
    const s = setup(calls);
    const first = s.orchestrator.run('goal', { tabId: 7, executionMode: 'auto', consentContext: context });
    await expect(s.orchestrator.run('other', { tabId: 7, executionMode: 'auto', consentContext: context })).resolves.toEqual({ state: 'failed', code: 'TASK_ALREADY_RUNNING' });
    await expect(first).resolves.toEqual({ state: 'failed', code: 'MAX_TURNS_EXCEEDED' });
  });
});
