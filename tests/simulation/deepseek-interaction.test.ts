// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createQwenSimulation } from '../helpers/qwen-simulator';

let simulation: ReturnType<typeof createQwenSimulation> | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { await simulation?.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

it('runs a DeepSeek tool turn through the supplied composer DOM and returns its result', async () => {
  const tool = '<tool_call id="call_1">{"id":"call_1","tool":"bash","args":{"cmd":"ls -la /work","workspace":"read"}}</tool_call id="call_1">';
  const s = simulation = createQwenSimulation([
    { snapshots: [tool.slice(0, 45), tool] },
    { snapshots: ['目录已检查。'] },
  ], true, 'DeepSeek');
  expect(await s.client.listConnectedTabs()).toEqual([{ id: 7, title: 'DeepSeek', provider: 'DeepSeek' }]);
  void s.start();
  expect(await s.finish()).toEqual({ state: 'completed', text: '目录已检查。' });
  expect(s.vm.exec).toHaveBeenCalledExactlyOnceWith('cd /work && ls -la /work', { timeoutMs: 120_000 });
  expect(s.prompts).toHaveLength(2);
  expect(s.prompts[1]).toContain('(empty workspace)');
  expect(s.events.some(event => event.kind === 'CONTENT_ERROR')).toBe(false);
  expect(s.unexpectedPrompts).toEqual([]);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(s.events.some(event => event.code === 'CONTENT_TIMEOUT')).toBe(false);
});

it('recovers invalid XML, accepts the reported prose plus read_file, and continues through a long fenced edit', async () => {
  const read = '我来逐步修改这个五子棋demo。首先让我读取当前的文件，确认内容后从最小的样式调整开始。\n<tool_call>{"id":"read_1","tool":"read_file","args":{"path":"index.html"}}</tool_call>';
  const content = '<html><script>const text=' + JSON.stringify('中文*下划线_'.repeat(5000)) + ';</script></html>';
  const write = '下面写入文件。\n```xml\n<tool_call>' + JSON.stringify({ id: 'write_long', tool: 'write_file', args: { path: 'index.html', content } }) + '</tool_call>\n```';
  const s = simulation = createQwenSimulation([
    { snapshots: ['<tool_call>{bad}</tool_call>'] },
    { snapshots: [read.slice(0, 80), read], remount: true },
    { snapshots: [write.slice(0, 500), write], remount: true },
    { snapshots: ['修改完成。'] },
  ], true, 'DeepSeek');
  s.files.set('index.html', '<html>旧页面</html>');
  void s.start();
  expect(await s.finish()).toEqual({ state: 'completed', text: '修改完成。' });
  expect(s.prompts[1]).toContain('TOOL_CALL_INVALID');
  expect(s.prompts[2]).toContain('<tool_result id="read_1">');
  expect(s.prompts[3]).toContain('<tool_result id="write_long">');
  expect(s.events.some(event => event.kind === 'CONTENT_ERROR')).toBe(false);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(s.events.some(event => event.code === 'CONTENT_TIMEOUT')).toBe(false);
});
