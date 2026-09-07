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
  const recovery = vi.fn();
  const orchestrator = new AgentOrchestrator({ tab, dispatcher, approvals, changes, consents, onRecovery: recovery, onState: (state) => states.push(state) });
  return { orchestrator, tab, dispatcher, approvals, changes, consents, states, recovery };
};

describe('AgentOrchestrator', () => {
  it('attaches images only to the initial request, never tool result follow-ups', async () => {
    const s = setup(['<tool_call>{"id":"image_read","tool":"read_file","args":{"path":"index.html"}}</tool_call>', '完成']);
    const images = [{ name: 'screenshot.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }];
    await s.orchestrator.run('按截图修改页面', { tabId: 7, executionMode: 'auto', consentContext: context, images });
    expect(s.tab.sendPrompt.mock.calls[0][2]).toMatchObject({ images });
    expect(s.tab.sendPrompt.mock.calls[1][2]).not.toHaveProperty('images');
    expect(s.tab.sendPrompt.mock.calls[0][1]).not.toContain('base64');
  });
  it.each(['write_file', 'bash'] as const)('auto-write automates redacted release but confirms only shell: %s', async tool => {
    const args = tool === 'bash' ? { cmd: 'pwd && ls -la', workspace: 'read' } : { path: 'index.html', content: '<html>demo</html>' };
    const s = setup(['我来创建页面。<tool_call>' + JSON.stringify({ id: 'call_3', tool, args }) + '</tool_call>', '完成']);
    const result = await s.orchestrator.run('创建页面', { tabId: 7, executionMode: 'auto-write', consentContext: context });
    expect(result.state).toBe('completed');
    expect(s.recovery).not.toHaveBeenCalled();
    expect(s.approvals.requestTool).toHaveBeenCalledTimes(tool === 'bash' ? 1 : 0);
    expect(s.changes.review).not.toHaveBeenCalled();
    expect(s.approvals.requestResultRelease).not.toHaveBeenCalled();
    expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('[REDACTED:aws-access-key]');
    expect(s.tab.sendPrompt.mock.calls[1][1]).not.toContain('AKIA1234567890ABCDEF');
  });

  it('executes the reported malformed HTML call once, then sends its result and completes', async () => {
    const content = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8"></head><body><button onclick="alert(\'Hello World!\')">点击我</button></body></html>';
    const value = { id: 'call_3', tool: 'write_file', args: { path: '/work/index.html', content } };
    const answer = `<tool_call_to_1>${JSON.stringify(value).replaceAll('\\"', '"')}</tool_call_to_1>`;
    const s = setup([answer, '页面已创建并验证']);
    await expect(s.orchestrator.run('创建 HTML', { tabId: 7, executionMode: 'confirm-each', consentContext: context }))
      .resolves.toEqual({ state: 'completed', text: '页面已创建并验证' });
    expect(s.dispatcher.execute).toHaveBeenCalledWith({ ...value, args: { path: 'index.html', content } }, expect.anything(), expect.any(AbortSignal));
    expect(s.dispatcher.execute).toHaveBeenCalledTimes(1);
    expect(s.recovery).not.toHaveBeenCalled();
    expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('<tool_result id="call_3">');
    expect(s.states.at(-1)).toBe('completed');
  });

  it('uses a valid escaped HTML example and a single encoding in both initial and repair prompts', async () => {
    const s = setup(['<tool_call>{</tool_call>', 'done']);
    await s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context });
    for (const [, prompt] of s.tab.sendPrompt.mock.calls) {
      expect(prompt).not.toContain('<invoke');
      expect(prompt).not.toContain('<tool_call_to_1>');
      const examples = [...prompt.matchAll(/<tool_call>(.*?)<\/tool_call>/g)]
        .filter(match => match[1].includes('"id":"write_1"'));
      expect(examples).toHaveLength(1);
      const example = JSON.parse(examples[0][1]);
      expect(example.args.path).toBe('index.html');
      expect(example.args.content).toContain('\n<html lang="zh-CN">');
    }
  });
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

  it('asks the model to correct invalid syntax, then resumes execution and result feedback', async () => {
    const s = setup(['<tool_call>{</tool_call>', '<tool_call>{"id":"fixed","tool":"bash","args":{"cmd":"pwd","workspace":"read"}}</tool_call>', 'finished']);
    await expect(s.orchestrator.run('inspect workspace', { tabId: 7, executionMode: 'confirm-each', consentContext: context }))
      .resolves.toEqual({ state: 'completed', text: 'finished' });
    expect(s.tab.sendPrompt).toHaveBeenCalledTimes(3);
    expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('TOOL_CALL_INVALID');
    expect(s.recovery).toHaveBeenCalledWith(expect.stringContaining('1/2'));
    expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('not executed');
    expect(s.tab.sendPrompt.mock.calls[2][1]).toContain('<tool_result id="fixed">');
    expect(s.approvals.requestTool).toHaveBeenCalledTimes(1);
    expect(s.dispatcher.execute).toHaveBeenCalledTimes(1);
    expect(s.dispatcher.abort).not.toHaveBeenCalled();
  });

  it('limits format corrections to two retries without executing invalid calls', async () => {
    const s = setup(Array(5).fill('<tool_call>{</tool_call>'));
    await expect(s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context }))
      .resolves.toEqual({ state: 'failed', code: 'TOOL_FORMAT_RETRIES_EXHAUSTED' });
    expect(s.tab.sendPrompt).toHaveBeenCalledTimes(3);
    expect(s.dispatcher.execute).not.toHaveBeenCalled();
    expect(s.approvals.requestTool).not.toHaveBeenCalled();
  });

  it('continues through Qwen calls that reuse native index 1 in successive turns', async () => {
    const native = (cmd: string) => `<tool_call_to_1><invoke name="bash"><parameter name="cmd">${cmd}</parameter</invoke></tool_call_to_1>`;
    const s = setup([native('ls -la /work'), native('cat /work/demo.html'), 'finished']);
    await expect(s.orchestrator.run('inspect files', { tabId: 7, executionMode: 'confirm-each', consentContext: context }))
      .resolves.toEqual({ state: 'completed', text: 'finished' });
    expect(s.dispatcher.execute).toHaveBeenCalledTimes(2);
    expect(s.approvals.requestTool).toHaveBeenCalledTimes(2);
    const calls = s.approvals.requestTool.mock.calls as unknown as Array<[ { id: string } ]>;
    expect(calls[0][0].id).not.toBe(calls[1][0].id);
    expect(s.tab.sendPrompt.mock.calls[2][1]).toContain('<tool_result');
  });

  it('can cancel while waiting for a corrected model response', async () => {
    const s = setup(['<tool_call>{</tool_call>']);
    s.tab.sendPrompt.mockImplementationOnce(async (_id, _prompt, handlers) => { handlers?.onDelta?.('<tool_call>{</tool_call>'); });
    s.tab.sendPrompt.mockImplementationOnce((_id, _prompt, handlers) => new Promise<void>((_resolve, reject) => {
      handlers?.signal?.addEventListener('abort', () => reject(new Error('USER_STOP')), { once: true });
    }));
    const pending = s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context });
    await vi.waitFor(() => expect(s.tab.sendPrompt).toHaveBeenCalledTimes(2));
    s.orchestrator.cancel('USER_STOP');
    await expect(pending).resolves.toEqual({ state: 'cancelled', code: 'USER_STOP' });
    expect(s.dispatcher.execute).not.toHaveBeenCalled();
  });

  it('rechecks auto consent before sending a format correction', async () => {
    const s = setup(['<tool_call>{</tool_call>']);
    s.consents.hasValid.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(s.orchestrator.run('goal', { tabId: 7, executionMode: 'auto', consentContext: context }))
      .resolves.toEqual({ state: 'failed', code: 'AUTO_CONSENT_REVOKED' });
    expect(s.tab.sendPrompt).toHaveBeenCalledTimes(1);
    expect(s.dispatcher.execute).not.toHaveBeenCalled();
  });

  it('does not retry execution errors as if the tool had not run', async () => {
    const s = setup(['<tool_call>{"id":"x","tool":"bash","args":{"cmd":"pwd","workspace":"read"}}</tool_call>']);
    s.dispatcher.execute.mockRejectedValueOnce(new Error('TOOL_CALL_INVALID'));
    await expect(s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context }))
      .resolves.toEqual({ state: 'failed', code: 'TOOL_CALL_INVALID' });
    expect(s.tab.sendPrompt).toHaveBeenCalledTimes(1);
    expect(s.recovery).not.toHaveBeenCalled();
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

  it('adds redacted user supplemental instructions without letting them replace fixed safety rules', async () => {
    // Break caught: custom instructions either silently disappear or are inserted ahead of the immutable /work and tool policy.
    const s = setup(['finished']);
    await s.orchestrator.run('goal', {
      tabId: 7,
      executionMode: 'confirm-each',
      consentContext: context,
      customInstructions: 'Reply in Chinese. Key: AKIA1234567890ABCDEF',
    });

    const prompt = s.tab.sendPrompt.mock.calls[0][1] as string;
    expect(prompt.indexOf('The only mounted workspace path is /work.')).toBeLessThan(prompt.indexOf('User supplemental instructions:'));
    expect(prompt).toContain('Reply in Chinese. Key: [REDACTED:aws-access-key]');
    expect(prompt).not.toContain('AKIA1234567890ABCDEF');
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

describe('external text tool bridge', () => {
  const denial = '当前对话环境没有提供用户描述的 bash/read_file/write_file 工具接口，因此我不能实际发出该格式的 tool_call 或操作 /work。';
  const options = { tabId: 7, executionMode: 'auto' as const, consentContext: context };
  it('explains the bridge once, executes the corrected request and waits for its result', async () => {
    const s = setup([denial, '<tool_call>{"id":"bridge_1","tool":"read_file","args":{"path":"index.html"}}</tool_call>', '已读取并验证']);
    const result = await s.orchestrator.run('检查 index.html', options);
    expect(result.state).toBe('completed');
    expect(s.tab.sendPrompt.mock.calls[0][1]).toContain('not ChatGPT/provider-native function calling');
    expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('Do not simulate execution or invent results');
    expect(s.tab.sendPrompt.mock.calls[1][1]).not.toContain('## Immutable operating boundary');
    expect(s.tab.sendPrompt.mock.calls[2][1]).toContain('<tool_result');
    expect(s.dispatcher.execute).toHaveBeenCalledOnce();
    expect(s.recovery).toHaveBeenCalledOnce();
    expect(s.states.filter(state => state === 'completed')).toHaveLength(1);
  });
  it('recovers the screenshot refusal without tool names and never executes its native Python snippet', async () => {
    const refusal = '我目前无法访问你要求的 kcode 工作区工具，因此不能读取 /work/index.html、修改文件或验证修复结果。请重新发起一次请求（确保 kcode 工具可用），我会按步骤读取 index.html。我不会假装已经修改了文件。';
    const s = setup([refusal, '<tool_call>{"id":"external_read","tool":"read_file","args":{"path":"index.html"}}</tool_call>', '已读取文件']);
    await s.orchestrator.run('修复 icell is not defined', options);
    expect(s.tab.sendPrompt.mock.calls[0][1]).toContain('do not call the chat provider native Python');
    expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('final visible text response');
    expect(s.dispatcher.execute).toHaveBeenCalledOnce();
    expect(s.dispatcher.execute).toHaveBeenCalledWith(expect.objectContaining({ tool: 'read_file', args: { path: 'index.html' } }), expect.anything(), expect.any(AbortSignal));
    expect(s.recovery).toHaveBeenCalledOnce();
  });
  it('does not label repeated transport refusal as a completed task or retry forever', async () => {
    const s = setup([denial, denial]);
    const result = await s.orchestrator.run('创建页面', options);
    expect(result).toMatchObject({ state: 'failed', code: 'TOOL_BRIDGE_UNAVAILABLE' });
    expect(s.tab.sendPrompt).toHaveBeenCalledTimes(2);
    expect(s.dispatcher.execute).not.toHaveBeenCalled();
    expect(s.states).not.toContain('completed');
  });
  it.each(['无法读取 index.html：文件不存在。', 'I cannot help with stealing credentials.', '页面已完成并通过 read_file 验证。'])('does not treat an execution error, safety refusal or normal result as a missing bridge: %s', async answer => {
    const s = setup([answer]);
    await s.orchestrator.run('检查项目', options);
    expect(s.tab.sendPrompt).toHaveBeenCalledOnce();
    expect(s.recovery).not.toHaveBeenCalled();
  });
});

it('automates edit_file in auto-write mode with read/write authority and a reviewed transaction', async () => {
  const s = setup(['<tool_call>{"id":"edit_auto","tool":"edit_file","args":{"path":"index.html","old_string":"icell","new_string":"i*cell"}}</tool_call>', '已编辑']);
  const outcome = await s.orchestrator.run('修复代码', { tabId: 7, executionMode: 'auto-write', consentContext: context });
  expect(outcome.state).toBe('completed');
  expect(s.approvals.requestTool).not.toHaveBeenCalled();
  expect(s.dispatcher.execute).toHaveBeenCalledWith(expect.objectContaining({ tool: 'edit_file' }), { source: 'auto-consent', capabilities: ['read', 'write'] }, expect.any(AbortSignal));
  expect(s.dispatcher.resolveChanges).toHaveBeenCalledWith('tx_1', 'accept', expect.any(AbortSignal));
  expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('<tool_result');
});

it('removes shell ANSI before redaction and release without altering raw terminal results', async () => {
  const s = setup(['<tool_call>{"id":"ls_1","tool":"bash","args":{"cmd":"ls -la /work","workspace":"read"}}</tool_call>', 'done']);
  const raw = execution();
  raw.result.text = 'total 3\r\n\x1b[0;0mindex.html\x1b[m\r\nAKIA1234\x1b[31m567890ABCDEF';
  s.dispatcher.execute.mockResolvedValue(raw);
  await s.orchestrator.run('list', { tabId: 7, executionMode: 'auto', consentContext: context });
  const released = s.tab.sendPrompt.mock.calls[1][1];
  expect(released).toContain('total 3\nindex.html\n');
  expect(released).not.toContain('U+001B');
  expect(released).not.toContain('[0;0m');
  expect(released).toContain('[REDACTED:aws-access-key]');
  expect(raw.result.text).toContain('\x1b[0;0m');
});

it('sends the precise validation failure to both the UI and the correction prompt', async () => {
  const s = setup(['<tool_call>{"id":"bad","tool":"bash","args":{"cmd":"pwd"}}</tool_call>', 'done']);
  await s.orchestrator.run('goal', { tabId: 7, executionMode: 'confirm-each', consentContext: context });
  expect(s.recovery).toHaveBeenCalledWith(expect.stringContaining('args 缺少必填字段：workspace'));
  expect(s.tab.sendPrompt.mock.calls[1][1]).toContain('Specific validation failure: args 缺少必填字段：workspace');
  expect(s.dispatcher.execute).not.toHaveBeenCalled();
});

it('reassembles a long XML JSON call when deltas split escaped double quotes', async () => {
  const { longToolCall, longToolEnvelope } = await import('../helpers/long-tool-envelope');
  const s = setup([]);
  let sent = false;
  s.tab.sendPrompt.mockImplementation(async (_tab, _prompt, handlers) => {
    if (sent) { handlers?.onDelta?.('done'); return; }
    sent = true;
    const envelope = longToolEnvelope();
    // End each chunk at an escape backslash, so its quote arrives separately.
    let start = 0;
    for (let end = envelope.indexOf('\\"'); end >= 0; end = envelope.indexOf('\\"', start)) {
      handlers?.onDelta?.(envelope.slice(start, end + 1)); start = end + 1;
    }
    handlers?.onDelta?.(envelope.slice(start));
  });
  const result = await s.orchestrator.run('write page', { tabId: 7, executionMode: 'auto', consentContext: context });
  expect(result.state).toBe('completed');
  expect(s.dispatcher.execute).toHaveBeenCalledExactlyOnceWith(longToolCall(), expect.anything(), expect.any(AbortSignal));
  expect(s.recovery).not.toHaveBeenCalled();
});

it.each([
  ['standard', 256, null, 'Network: offline'],
  ['high', 512, 'wss://relay.example/', 'Network: WISP outbound TCP'],
] as const)('includes the current %s VM configuration in the model system prompt', async (memoryProfile, ram, relayUrl, networkText) => {
  const s = setup(['done']);
  await s.orchestrator.run('inspect project', { tabId: 7, executionMode: 'confirm-each', memoryProfile, consentContext: { ...context, relayUrl } });
  const prompt = s.tab.sendPrompt.mock.calls[0][1];
  expect(prompt).toContain('## Current VM environment');
  expect(prompt).toContain(`Configured RAM: ${ram} MiB`);
  expect(prompt).toContain(networkText);
  expect(prompt).toContain('32-bit x86 (i386)');
  expect(prompt).toContain('/bin/sh (BusyBox ash)');
  expect(prompt).toContain('GNU Bash is not preinstalled');
  expect(prompt).toContain('120000 ms');
  expect(prompt).toContain('Model-response waiting has no fixed timeout');
  expect(prompt).toContain('Guest /tmp is temporary scratch space');
});

it('keeps user task and supplemental instructions as literal text rather than HTML entities', async () => {
  const s = setup(['done']);
  const goal = '修改 <div title="a&b">，原样保留字面量 &quot;';
  await s.orchestrator.run(goal, { tabId: 7, executionMode: 'confirm-each', consentContext: context, customInstructions: '保留 "双引号" 和 <标签>' });
  const prompt = s.tab.sendPrompt.mock.calls[0][1];
  expect(prompt).toContain('## User goal\n' + goal);
  expect(prompt).toContain('User supplemental instructions:\n保留 "双引号" 和 <标签>');
  expect(prompt).not.toContain('&lt;div'); expect(prompt).not.toContain('&amp;quot;');
});
