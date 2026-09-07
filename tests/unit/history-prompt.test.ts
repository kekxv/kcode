import { expect, it } from 'vitest';
import { continuationPrompt } from '../../src/sidepanel/history-prompt';
it('formats all history as readable text while preserving literal quotes, newlines and tool contents', () => {
  const content = '<div title="a&b">\nhello\n</div>';
  const prompt = continuationPrompt({ id: '1', createdAt: 1, provider: 'Qwen', task: 'old', outcome: 'done', status: 'completed', messages: [
    { role: 'user', text: '美化项目，保留 "引用"' },
    { role: 'tool', text: '', tool: { id: 'write', tool: 'write_file', args: { path: 'index.html', content } }, status: 'done', result: { text: '已写入', exitCode: 0, truncated: false, durationMs: 2 } },
    { role: 'system', text: '任务结束：ADAPTER_DOM_CHANGED' },
  ] }, '继续验证');
  expect(prompt).toContain('### 1. 用户\n\n美化项目，保留 "引用"');
  expect(prompt).toContain(`content:\n${content}`);
  expect(prompt).toContain('### 3. 系统记录');
  expect(prompt).toContain('---\n\n## 本次请求\n\n继续验证');
  expect(prompt).not.toContain('&quot;'); expect(prompt).not.toContain('{"role":');
});
