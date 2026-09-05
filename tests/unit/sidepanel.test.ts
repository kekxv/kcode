// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import App, { sidePanelServicesKey, type SidePanelServices } from '../../src/sidepanel/App.vue';
import { TabClient } from '../../src/sidepanel/tab-client';

const fakeServices = (ready = false): SidePanelServices => {
  let transactionId = 'no_transaction';
  const journal = (state: 'clean' | 'dirty' = 'clean') => ({ transactionId, state, entries: state === 'dirty' ? [{ path: 'notes.txt', operation: 'write' as const, originalBytes: 0, resultingBytes: 2 }] : [], journalBytes: state === 'dirty' ? 10 : 0, writtenBytes: state === 'dirty' ? 2 : 0 });
  return {
    workspace: {
      load: vi.fn().mockResolvedValue(ready ? { workspaceId: 'workspace-1', handle: { kind: 'directory' } } : null),
      selectDirectory: vi.fn(),
      getPermission: vi.fn().mockResolvedValue(ready ? 'granted' : 'prompt'),
      requestReadWrite: vi.fn().mockResolvedValue('granted'),
    },
    tab: { listConnectedTabs: vi.fn().mockResolvedValue(ready ? [{ id: 7, title: 'DeepSeek', provider: 'DeepSeek' as const }] : []), sendPrompt: vi.fn() },
    vm: {
      terminate: vi.fn(), selectMemoryProfile: vi.fn(), attachWorkspace: vi.fn(async () => undefined), start: vi.fn(async () => undefined), subscribe: vi.fn(() => () => {}),
      beginTransaction: vi.fn(async (next: string) => { transactionId = next; }),
      exec: vi.fn(async () => ({ output: 'AKIA1234567890ABCDEF', exitCode: 0, truncated: false, durationMs: 1, transactionId, journalSummary: journal(transactionId === 'no_transaction' ? 'clean' : 'dirty') })),
      readFile: vi.fn(async () => ({ text: 'file', truncated: false, durationMs: 1, transactionId, journalSummary: journal() })),
      writeFile: vi.fn(async () => ({ text: '', truncated: false, durationMs: 1, transactionId, journalSummary: journal('dirty') })),
      commitTransaction: vi.fn(async () => undefined), rollbackTransaction: vi.fn(async () => undefined),
    },
    consent: { grant: vi.fn(), hasValid: vi.fn().mockResolvedValue(false), revokeAll: vi.fn() },
    relaySettings: { load: vi.fn().mockResolvedValue(null), save: vi.fn(async (value: string) => value), clear: vi.fn() },
    agentSettings: { load: vi.fn().mockResolvedValue(''), save: vi.fn(async (value: string) => value), clear: vi.fn() },
    workspaceHistory: { load: vi.fn().mockResolvedValue([]), append: vi.fn(), clear: vi.fn(), loadRecovery: vi.fn().mockResolvedValue(null), saveRecovery: vi.fn(), clearRecovery: vi.fn() },
  };
};

afterEach(() => cleanup());

const openSettings = async (): Promise<void> => {
  await fireEvent.click(screen.getByRole('button', { name: '会话设置' }));
  await screen.findByRole('dialog', { name: '会话设置' });
};

describe('Side Panel shell', () => {
  it('lists only tabs reported by the authenticated background Port', async () => {
    // Break caught: the panel calls chrome.tabs.query or accepts a mismatched listing response.
    let listener: ((message: unknown) => void) | undefined;
    const port = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn((next) => { listener = next; }) },
      onDisconnect: { addListener: vi.fn() },
    };
    const client = new TabClient(() => port as unknown as chrome.runtime.Port);
    const pending = client.listConnectedTabs();
    const request = port.postMessage.mock.calls[0][0] as { requestId: string };
    listener?.({ protocolVersion: 1, kind: 'SIDE_PANEL_CONNECTED_TABS', requestId: 'wrong', tabs: [{ tabId: 4, title: 'Wrong', provider: 'ChatGPT' }] });
    listener?.({ protocolVersion: 1, kind: 'SIDE_PANEL_CONNECTED_TABS', requestId: request.requestId, tabs: [{ tabId: 7, title: 'DeepSeek', provider: 'DeepSeek' }] });

    await expect(pending).resolves.toEqual([{ id: 7, title: 'DeepSeek', provider: 'DeepSeek' }]);
  });

  it('cancels the matching page request when its AbortSignal fires', async () => {
    // Break caught: stopping the agent only locally leaves the authenticated content observer and DeepSeek generation active.
    let listener: ((message: unknown) => void) | undefined;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: { addListener: vi.fn((next) => { listener = next; }) },
      onDisconnect: { addListener: vi.fn() },
    };
    const client = new TabClient(() => port as unknown as chrome.runtime.Port);
    const controller = new AbortController();
    const pending = client.sendPrompt(7, 'hello', { signal: controller.signal });
    const request = port.postMessage.mock.calls[0][0] as { requestId: string };

    controller.abort('USER_STOP');

    await expect(pending).rejects.toThrow('USER_STOP');
    expect(port.postMessage).toHaveBeenLastCalledWith({ protocolVersion: 1, kind: 'CONTENT_ABORT_REQUEST', requestId: request.requestId, targetTabId: 7 });
    listener?.({ protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: request.requestId, sourceTabId: 7 });
    expect(port.postMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps submit disabled until directory and DeepSeek are ready', async () => {
    // Break caught: a prompt can begin without both the workspace and authenticated content connection.
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: fakeServices(false) } } });
    const submit = await screen.findByRole('button', { name: '开始任务' });
    expect(submit).toHaveProperty('disabled', true);
  });

  it('keeps the task composer editable while setup is incomplete', async () => {
    // Break caught: coupling the composer to send readiness makes normal text editing and IME composition unavailable before setup.
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: fakeServices(false) } } });
    const task = await screen.findByRole('textbox', { name: '任务' });
    expect(task).not.toHaveProperty('disabled', true);
    await fireEvent.update(task, 'write hello.txt');
    expect(task).toHaveProperty('value', 'write hello.txt');
  });

  it('refreshes the chat connection after the chat page becomes available', async () => {
    // Break caught: the side panel snapshots its connection state at mount and remains disconnected after a chat tab finishes loading.
    const services = fakeServices(false);
    (services.tab.listConnectedTabs as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 7, title: 'DeepSeek', provider: 'DeepSeek' }]);
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByText('未连接聊天');
    await fireEvent.click(screen.getByRole('button', { name: '刷新聊天连接' }));
    await waitFor(() => expect(screen.getByText('聊天已连接')).toBeTruthy());
    expect(services.tab.listConnectedTabs).toHaveBeenCalledTimes(2);
  });

  it('shows trusted relay settings independently of network consent state', async () => {
    // Break caught: the only relay configuration path is hidden behind enabling authority, so it cannot be validated and saved first.
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: fakeServices(false) } } });
    await openSettings();
    expect(await screen.findByRole('textbox', { name: 'WISP relay URL' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存中继' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '清除中继' })).toBeTruthy();
  });

  it('shows a local supplemental instruction editor before a task begins', async () => {
    // Break caught: users cannot inspect or change the text that will accompany every task in the selected chat.
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: fakeServices(false) } } });
    await openSettings();
    expect(await screen.findByRole('textbox', { name: '自定义 Agent 指令' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存指令' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '清除指令' })).toBeTruthy();
  });

  it('requires an explicit gesture before writing redacted work history', async () => {
    // Break caught: completing an ordinary task requests write permission or
    // stores a raw token without a separate, informed history opt-in.
    const services = fakeServices(true);
    services.tab.sendPrompt = vi.fn(async (_tabId, _prompt, handlers) => { handlers?.onDelta?.('完成'); });
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('button', { name: '开始任务' });
    await openSettings();
    expect(screen.getByRole('button', { name: '启用工作记录（写入 .session）' })).toBeTruthy();

    await fireEvent.update(screen.getByRole('textbox', { name: '任务' }), '处理 ghp_12345678901234567890');
    await fireEvent.click(screen.getByRole('button', { name: '开始任务' }));
    await waitFor(() => expect(services.tab.sendPrompt).toHaveBeenCalledOnce());
    expect(services.workspace.requestReadWrite).not.toHaveBeenCalled();
    expect(services.workspaceHistory.append).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: '启用工作记录（写入 .session）' }));
    await waitFor(() => expect(services.workspace.requestReadWrite).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '清除工作记录' })).toBeTruthy();

    await fireEvent.update(screen.getByRole('textbox', { name: '任务' }), '处理 ghp_12345678901234567890');
    await fireEvent.click(screen.getByRole('button', { name: '开始任务' }));
    await waitFor(() => expect(services.workspaceHistory.append).toHaveBeenCalledOnce());
    const record = (services.workspaceHistory.append as ReturnType<typeof vi.fn>).mock.calls[0][1] as { task: string };
    expect(record.task).toContain('[REDACTED:github-token]');
    expect(record.task).not.toContain('ghp_12345678901234567890');
  });

  it('offers an interrupted checkpoint only after a user confirms resume', async () => {
    // Break caught: panel reload either loses an interrupted task or silently
    // sends its continuation to a chat page without a fresh user gesture.
    const services = fakeServices(true);
    const recovery = services.workspaceHistory as typeof services.workspaceHistory & { loadRecovery: ReturnType<typeof vi.fn> };
    recovery.loadRecovery = vi.fn().mockResolvedValue({ updatedAt: 1, provider: 'DeepSeek', task: '继续整理需求', phase: 'running', summary: '已完成目录检查' });
    services.tab.sendPrompt = vi.fn(async (_tabId, _prompt, handlers) => { handlers?.onDelta?.('恢复完成'); });
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await openSettings();

    expect((await screen.findByRole('region', { name: '恢复上次任务' })).textContent).toContain('继续整理需求');
    expect(services.tab.sendPrompt).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: '恢复任务' }));
    await waitFor(() => expect(services.tab.sendPrompt).toHaveBeenCalledOnce());
    expect((services.tab.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('继续整理需求');
  });

  it('removes the visible recovery offer when the user clears .session history', async () => {
    // Break caught: deleting the SQLite file leaves a stale resume button that
    // advertises a checkpoint no longer present in the selected workspace.
    const services = fakeServices(true);
    services.workspaceHistory.loadRecovery = vi.fn().mockResolvedValue({ updatedAt: 1, provider: 'DeepSeek', task: 'interrupted', phase: 'running', summary: 'checkpoint' });
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('region', { name: '恢复上次任务' });
    await openSettings();
    await fireEvent.click(screen.getByRole('button', { name: '启用工作记录（写入 .session）' }));
    await fireEvent.click(screen.getByRole('button', { name: '清除工作记录' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: '恢复上次任务' })).toBeNull());
  });

  it('saves supplemental instructions and attaches them to the next task only after fixed safety policy', async () => {
    // Break caught: the visible editor persists text but the orchestrator never receives it, or injects it before immutable controls.
    const services = fakeServices(true);
    services.tab.sendPrompt = vi.fn(async (_tabId, _prompt, handlers) => { handlers?.onDelta?.('完成'); });
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await openSettings();
    const custom = await screen.findByRole('textbox', { name: '自定义 Agent 指令' });

    await fireEvent.update(custom, '始终用中文总结。');
    await fireEvent.click(screen.getByRole('button', { name: '保存指令' }));
    await waitFor(() => expect(services.agentSettings.save).toHaveBeenCalledWith('始终用中文总结。'));
    await fireEvent.update(screen.getByRole('textbox', { name: '任务' }), '列出目录');
    await fireEvent.click(screen.getByRole('button', { name: '开始任务' }));

    await waitFor(() => expect(services.tab.sendPrompt).toHaveBeenCalledOnce());
    const prompt = (services.tab.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(prompt.indexOf('The only mounted workspace path is /work.')).toBeLessThan(prompt.indexOf('User supplemental instructions:'));
    expect(prompt).toContain('始终用中文总结。');
  });

  it('terminates execution and revokes session consent before persisting a changed relay', async () => {
    // Break caught: a new relay becomes durable while an old VM/consent generation can still use the previous endpoint.
    const services = fakeServices(true);
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await openSettings();
    const relay = await screen.findByRole('textbox', { name: 'WISP relay URL' });

    await fireEvent.update(relay, 'wss://relay.example:443/new');
    await fireEvent.click(screen.getByRole('button', { name: '保存中继' }));

    await waitFor(() => expect(services.relaySettings.save).toHaveBeenCalledWith('wss://relay.example/new'));
    expect((services.vm.terminate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((services.consent.revokeAll as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect((services.consent.revokeAll as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((services.relaySettings.save as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it('runs a confirm-each tool turn through approval, journal review, and redacted release', async () => {
    // Break caught: the visible Start button must drive the bounded orchestrator instead of sending the raw goal once and stopping.
    const services = fakeServices(true);
    const answers = [
      '<tool_call>{"id":"call_1","tool":"bash","args":{"cmd":"printf ok > notes.txt","workspace":"write"}}</tool_call>',
      '任务完成',
    ];
    services.tab.sendPrompt = vi.fn(async (_tabId, _prompt, handlers) => { handlers?.onDelta?.(answers.shift() ?? ''); handlers?.onDone?.(); });
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    const task = await screen.findByRole('textbox', { name: '任务' });
    await fireEvent.update(task, '更新 notes.txt');
    await fireEvent.click(screen.getByRole('button', { name: '开始任务' }));

    expect((await screen.findByRole('region', { name: '工具批准' })).textContent).toContain('notes.txt');
    await fireEvent.click(screen.getByRole('button', { name: '运行工具' }));
    expect((await screen.findByRole('region', { name: '变更审阅' })).textContent).toContain('notes.txt');
    await fireEvent.click(screen.getByRole('button', { name: '接受变更' }));
    expect((await screen.findByRole('region', { name: '结果发布' })).textContent).toContain('[REDACTED:aws-access-key]');
    await fireEvent.click(screen.getByRole('button', { name: '发送脱敏结果' }));

    expect(await screen.findByText('任务完成')).toBeTruthy();
    expect(services.tab.sendPrompt).toHaveBeenCalledTimes(2);
    expect((services.tab.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[1][1]).toContain('[REDACTED:aws-access-key]');
    expect(services.vm.commitTransaction).toHaveBeenCalledOnce();
  });

  it('runs a valid auto tool turn without interactive gates and commits before release', async () => {
    // Break caught: auto can be displayed as enabled while Start still bypasses the orchestrator or waits on hidden confirm-each dialogs.
    const services = fakeServices(true);
    services.consent.hasValid = vi.fn().mockResolvedValue(true);
    const answers = [
      '<tool_call>{"id":"call_1","tool":"write_file","args":{"path":"notes.txt","content":"ok"}}</tool_call>',
      '自动任务完成',
    ];
    services.tab.sendPrompt = vi.fn(async (_tabId, _prompt, handlers) => { handlers?.onDelta?.(answers.shift() ?? ''); handlers?.onDone?.(); });
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('button', { name: '开始任务' });
    await openSettings();
    await fireEvent.click(screen.getByRole('checkbox', { name: '启用 Auto' }));
    await screen.findByRole('dialog', { name: '高风险能力确认' });
    for (const box of screen.getAllByRole('checkbox', { name: /AI 可以|仓库|工具结果|操作可能/ })) await fireEvent.click(box);
    await fireEvent.click(screen.getByRole('button', { name: '启用 Auto' }));
    await screen.findByText('Auto');
    await fireEvent.update(screen.getByRole('textbox', { name: '任务' }), '自动更新');
    await fireEvent.click(screen.getByRole('button', { name: '开始任务' }));

    expect(await screen.findByText('自动任务完成')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '工具批准' })).toBeNull();
    expect(screen.queryByRole('region', { name: '变更审阅' })).toBeNull();
    expect(screen.queryByRole('region', { name: '结果发布' })).toBeNull();
    expect(services.vm.commitTransaction).toHaveBeenCalledOnce();
    expect((services.vm.commitTransaction as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan((services.tab.sendPrompt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]);
  });

  it('requires a visible confirmation before selecting the 512 MiB cold-boot profile', async () => {
    // Break caught: a passive select-model change silently doubles browser memory and discards the current VM state without an explicit user acknowledgement.
    const services = fakeServices(true);
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await openSettings();
    const memory = await screen.findByRole('combobox', { name: 'VM 内存' });
    expect((memory as HTMLSelectElement).value).toBe('standard');
    await fireEvent.update(memory, 'high');
    expect(await screen.findByRole('dialog', { name: '高内存冷启动确认' })).toBeTruthy();
    expect((memory as HTMLSelectElement).value).toBe('standard');
    await fireEvent.click(screen.getByRole('button', { name: '确认切换到 512 MiB' }));
    expect(services.vm.terminate).toHaveBeenCalledWith('VM_MEMORY_PROFILE_CHANGED');
    await waitFor(() => expect(services.vm.selectMemoryProfile).toHaveBeenCalledWith('high'));
    await waitFor(() => expect((memory as HTMLSelectElement).value).toBe('high'));
  });

  it('revokes auto and relay authority before a confirmed memory-profile cold restart', async () => {
    // Break caught: changing RAM while auto/WISP authority survives lets the next VM generation inherit a consent context that was bound to the old Worker.
    const services = fakeServices(true);
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('button', { name: '开始任务' });
    await openSettings();

    const relay = await screen.findByRole('textbox', { name: 'WISP relay URL' });
    await fireEvent.update(relay, 'wss://relay.example/wisp');
    await fireEvent.click(screen.getByRole('button', { name: '保存中继' }));
    await waitFor(() => expect(services.relaySettings.save).toHaveBeenCalledWith('wss://relay.example/wisp'));

    await fireEvent.click(screen.getByRole('checkbox', { name: '启用 Auto' }));
    await screen.findByRole('button', { name: '启用 Auto' });
    for (const box of screen.getAllByRole('checkbox', { name: /AI 可以|仓库|工具结果|操作可能/ })) await fireEvent.click(box);
    await fireEvent.click(screen.getByRole('button', { name: '启用 Auto' }));

    await fireEvent.click(screen.getByRole('checkbox', { name: '连接工作区网络' }));
    await screen.findByRole('dialog', { name: '高风险能力确认' });
    for (const box of screen.getAllByRole('checkbox', { name: /AI 可以|仓库|工具结果|操作可能|启用网络后|WISP 中继/ })) {
      if (!(box as HTMLInputElement).checked) await fireEvent.click(box);
    }
    await fireEvent.click(screen.getByRole('button', { name: '启用 Auto' }));
    expect(services.consent.grant).toHaveBeenLastCalledWith(['auto', 'workspace-networked'], { workspaceId: 'workspace-1', relayUrl: 'wss://relay.example/wisp' });

    const memory = screen.getByRole('combobox', { name: 'VM 内存' });
    await fireEvent.update(memory, 'high');
    await fireEvent.click(screen.getByRole('button', { name: '确认切换到 512 MiB' }));

    expect(await screen.findByText('确认每步')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '连接工作区网络' }) as HTMLInputElement).checked).toBe(false);
    expect(services.vm.terminate).toHaveBeenCalledWith('VM_MEMORY_PROFILE_CHANGED');
    expect(services.vm.selectMemoryProfile).toHaveBeenCalledWith('high');
    expect(services.consent.revokeAll).toHaveBeenCalledTimes(4);
  });

  it('does not let a pending consent grant restore auto after a memory-profile reset', async () => {
    // Break caught: an older grant continuation can reactivate auto after the high-memory switch has revoked its authority.
    let resolveGrant!: () => void;
    const services = fakeServices(true);
    services.consent.grant = vi.fn(() => new Promise<void>((resolve) => { resolveGrant = resolve; }));
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('button', { name: '开始任务' });
    await openSettings();
    await fireEvent.click(screen.getByRole('checkbox', { name: '启用 Auto' }));
    await screen.findByRole('dialog', { name: '高风险能力确认' });
    for (const box of screen.getAllByRole('checkbox', { name: /AI 可以|仓库|工具结果|操作可能/ })) await fireEvent.click(box);
    await fireEvent.click(screen.getByRole('button', { name: '启用 Auto' }));
    await waitFor(() => expect(services.consent.grant).toHaveBeenCalledOnce());

    const memory = screen.getByRole('combobox', { name: 'VM 内存' });
    await fireEvent.update(memory, 'high');
    await fireEvent.click(screen.getByRole('button', { name: '确认切换到 512 MiB' }));
    resolveGrant();

    await waitFor(() => expect(services.vm.selectMemoryProfile).toHaveBeenCalledWith('high'));
    expect(screen.getByText('确认每步')).toBeTruthy();
    expect(screen.queryByText('Auto')).toBeNull();
  });

  it('does not reopen an older high-risk dialog after a memory-profile reset', async () => {
    // Break caught: a delayed revoke continuation can restore stale checkbox state and a consent dialog after a newer reset.
    let resolveFirstRevoke!: () => void;
    const services = fakeServices(true);
    services.consent.revokeAll = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirstRevoke = resolve; }))
      .mockResolvedValue(undefined);
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('button', { name: '开始任务' });
    await openSettings();
    await fireEvent.click(screen.getByRole('checkbox', { name: '启用 Auto' }));

    const memory = screen.getByRole('combobox', { name: 'VM 内存' });
    await fireEvent.update(memory, 'high');
    await fireEvent.click(screen.getByRole('button', { name: '确认切换到 512 MiB' }));
    await waitFor(() => expect(services.vm.selectMemoryProfile).toHaveBeenCalledWith('high'));
    resolveFirstRevoke();

    await waitFor(() => expect(services.consent.revokeAll).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog', { name: '高风险能力确认' })).toBeNull();
    await waitFor(() => expect((screen.getByRole('checkbox', { name: '启用 Auto' }) as HTMLInputElement).checked).toBe(false));
  });

  it('requires every relevant warning check before an auto enable gesture', async () => {
    // Break caught: merely toggling auto, or checking only a subset of warnings, activates high-risk mode.
    const services = fakeServices(true);
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('button', { name: '开始任务' });
    await openSettings();
    await fireEvent.click(screen.getByRole('checkbox', { name: '启用 Auto' }));
    const enable = await screen.findByRole('button', { name: '启用 Auto' });
    expect(enable).toHaveProperty('disabled', true);
    for (const box of screen.getAllByRole('checkbox', { name: /AI 可以|仓库|工具结果|操作可能/ })) await fireEvent.click(box);
    expect(enable).toHaveProperty('disabled', false);
    await fireEvent.click(enable);
    expect(services.workspace.requestReadWrite).toHaveBeenCalledTimes(1);
    expect(services.consent.grant).toHaveBeenCalledWith(['auto'], { workspaceId: 'workspace-1', relayUrl: null });
  });

  it('stops and revokes active high-risk mode when the relay URL changes', async () => {
    // Break caught: a new relay path keeps authority granted for the old normalized full relay URL.
    const services = fakeServices(true);
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('button', { name: '开始任务' });
    await openSettings();
    const relay = await screen.findByRole('textbox', { name: 'WISP relay URL' });
    await fireEvent.update(relay, 'wss://relay.example/first');
    await fireEvent.click(screen.getByRole('button', { name: '保存中继' }));
    await waitFor(() => expect(services.relaySettings.save).toHaveBeenCalledWith('wss://relay.example/first'));
    await fireEvent.click(screen.getByRole('checkbox', { name: '连接工作区网络' }));
    await screen.findByRole('dialog', { name: '高风险能力确认' });
    for (const box of screen.getAllByRole('checkbox', { name: /启用网络后|WISP 中继/ })) await fireEvent.click(box);
    await fireEvent.click(screen.getByRole('button', { name: '启用 Auto' }));
    await screen.findByRole('alert');
    await fireEvent.update(relay, 'wss://relay.example/second');

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(services.vm.terminate).toHaveBeenCalledWith('RELAY_URL_CHANGED');
    expect(services.consent.revokeAll).toHaveBeenCalledTimes(3);
  });
});
