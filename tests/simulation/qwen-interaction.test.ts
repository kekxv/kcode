// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQwenSimulation, type QwenTurn } from '../helpers/qwen-simulator';

const html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8"></head><body><button onclick="alert(\'Hello World!\')">点击我</button></body></html>';
const write = `<tool_call_to_1>${JSON.stringify({ id: 'write_1', tool: 'write_file', args: { path: '/work/index.html', content: html } }).replaceAll('\\"', '"')}</tool_call_to_1>`;
const read = '<tool_call>{"id":"read_1","tool":"read_file","args":{"path":"/work/index.html"}}</tool_call>';
const listing = '<tool_call_to_1><invoke name="bash"><parameter name="cmd">ls -la /work</parameter</invoke></tool_call_to_1>';
let simulation: ReturnType<typeof createQwenSimulation> | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { await simulation?.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

const setup = (turns: QwenTurn[], approve = true) => (simulation = createQwenSimulation(turns, approve));

describe('Qwen simulated page → router → tools → next page turn', () => {
  it('executes the reported attributed tool_call before completing the task', async () => {
    const response = '<tool_call id="call_1">{"id":"call_1","tool":"bash","args":{"cmd":"ls -la /work","workspace":"read"}}</tool_call id="call_1">';
    const s = setup([{ snapshots: ['<tool_call id="call_1">', response] }, { snapshots: ['目录已检查。'] }]);
    void s.start();
    expect(await s.finish()).toEqual({ state: 'completed', text: '目录已检查。' });
    expect(s.vm.exec).toHaveBeenCalledExactlyOnceWith('cd /work && ls -la /work', { timeoutMs: 120_000 });
    expect(s.approvals).toHaveBeenCalledTimes(1);
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).toContain('<tool_result id="call_1">');
    expect(s.prompts[1]).toContain('(empty workspace)');
    expect(s.recoveries).toEqual([]);
  });

  it('does not mark an unrecognized tool wrapper as a completed task', async () => {
    const response = '<tool_call id="call_1" unexpected="true">{}</tool_call>';
    const s = setup(Array.from({ length: 3 }, () => ({ snapshots: [response] })));
    void s.start();
    expect(await s.finish()).toEqual({ state: 'failed', code: 'TOOL_FORMAT_RETRIES_EXHAUSTED' });
    expect(s.states).not.toContain('completed');
    expect(s.vm.exec).not.toHaveBeenCalled();
  });
  it('executes a named bash call after explanatory prose and continues with its result', async () => {
    const named = '我来帮你创建一个 HTML demo 项目。先检查一下工作区的情况。<tool_call_bash>\n<arg_key>cmd</arg_key>\n<arg_value>ls -la /work</arg_value>\n<arg_key>workspace</arg_key>\n<arg_value>read</arg_value>\n</tool_call_bash>';
    const s = setup([{ snapshots: ['我来帮你创建一个 HTML demo 项目。', named] }, { snapshots: [write] }, { snapshots: ['完成'] }]);
    void s.start();
    expect(await s.finish()).toEqual({ state: 'completed', text: '完成' });
    expect(s.prompts[1]).toContain('(empty workspace)');
    expect(s.vm.exec).toHaveBeenCalledTimes(1);
    expect(s.approvals.mock.calls[0][0]).toMatchObject({ tool: 'bash', args: { cmd: 'ls -la /work', workspace: 'read' } });
    expect(s.files.get('index.html')).toBe(html);
    expect(s.recoveries).toEqual([]);
  });
  it.each(['remove', 'hidden', 'relabel'] as const)('creates and verifies HTML across remounts when Stop ends via %s', async stop => {
    const s = setup([
      { snapshots: ['<tool_call_to_1>', listing], remount: true, stop },
      { snapshots: ['<tool_call_to_1>{', write.slice(0, 100), write], remount: true, stop },
      { snapshots: [read], stop },
      { snapshots: ['正在确认', '页面已创建并验证。'], stop },
    ]);
    expect(await s.client.listConnectedTabs()).toEqual([{ id: 7, title: 'Qwen', provider: 'Qwen' }]);
    void s.start();
    expect(await s.finish()).toEqual({ state: 'completed', text: '页面已创建并验证。' });
    expect(s.files.get('index.html')).toBe(html);
    expect(s.vm.exec).toHaveBeenCalledTimes(1);
    expect(s.vm.writeFile).toHaveBeenCalledExactlyOnceWith('index.html', html);
    expect(s.vm.readFile).toHaveBeenCalledExactlyOnceWith('index.html', undefined);
    expect(s.approvals).toHaveBeenCalledTimes(3);
    expect(s.prompts).toHaveLength(4);
    expect(s.prompts[2]).toContain('Wrote index.html');
    expect(s.prompts[3]).toContain('&lt;html lang=&quot;zh-CN&quot;');
    expect(s.recoveries).toEqual([]);
    expect(s.unexpectedPrompts).toEqual([]);
    expect(s.events.filter(event => event.kind === 'CONTENT_RESPONSE_DONE')).toHaveLength(4);
    expect(s.events.some(event => event.kind === 'CONTENT_ERROR')).toBe(false);
    // A completed provider turn must not later emit its old 90-second timeout.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(s.events.some(event => event.code === 'CONTENT_TIMEOUT')).toBe(false);
  });

  it('sends a correction back into the page and resumes the original task', async () => {
    const s = setup([{ snapshots: ['<tool_call>{</tool_call>'] }, { snapshots: [write] }, { snapshots: ['完成'] }]);
    void s.start();
    expect((await s.finish()).state).toBe('completed');
    expect(s.recoveries).toHaveLength(1);
    expect(s.prompts[1]).toContain('not executed');
    expect(s.vm.writeFile).toHaveBeenCalledTimes(1);
    expect(s.files.get('index.html')).toBe(html);
  });

  it('ends after two failed corrections without executing any tool', async () => {
    const s = setup(Array.from({ length: 3 }, () => ({ snapshots: ['<tool_call>{</tool_call>'] })));
    void s.start();
    expect(await s.finish()).toEqual({ state: 'failed', code: 'TOOL_FORMAT_RETRIES_EXHAUSTED' });
    expect(s.states.at(-1)).toBe('failed');
    expect(s.prompts).toHaveLength(3);
    expect(s.recoveries.filter(message => message.includes('正在请求模型修正'))).toHaveLength(2);
    expect(s.recoveries.at(-1)).toContain('工具调用未执行');
    expect(s.approvals).not.toHaveBeenCalled();
    expect(s.vm.start).not.toHaveBeenCalled();
  });

  it('waits beyond three minutes without releasing partial output, then executes the completed call', async () => {
    const s = setup([{ snapshots: [write], stop: 'stall' }, { snapshots: ['done'] }]);
    void s.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(s.vm.writeFile).not.toHaveBeenCalled();
    expect(s.events.filter(event => event.kind === 'CONTENT_RESPONSE_DELTA' || event.kind === 'CONTENT_ERROR')).toEqual([]);
    document.querySelector('button[aria-label="Stop"]')!.remove();
    expect(await s.finish()).toEqual({ state: 'completed', text: 'done' });
    expect(s.vm.writeFile).toHaveBeenCalledOnce();
  });

  it('cancels an active page stream and ignores its later response', async () => {
    const s = setup([{ snapshots: [write.slice(0, 80), write], stop: 'stall' }]);
    void s.start();
    await vi.advanceTimersByTimeAsync(150);
    s.cancel();
    expect(await s.finish()).toEqual({ state: 'cancelled', code: 'USER_STOP' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(s.vm.writeFile).not.toHaveBeenCalled();
    expect(s.events.some(event => event.kind === 'CONTENT_RESPONSE_DONE' || event.code === 'CONTENT_TIMEOUT')).toBe(false);
  });

  it('stops at rejected approval without writing or requesting another reply', async () => {
    const s = setup([{ snapshots: [write] }], false);
    void s.start();
    expect(await s.finish()).toEqual({ state: 'cancelled', code: 'TOOL_REJECTED' });
    expect(s.prompts).toHaveLength(1);
    expect(s.vm.writeFile).not.toHaveBeenCalled();
  });
});
