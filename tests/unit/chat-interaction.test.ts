// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';
import TaskComposer from '../../src/sidepanel/components/TaskComposer.vue';
import ChatFeed from '../../src/sidepanel/components/ChatFeed.vue';
afterEach(cleanup);
describe('conversation interactions', () => {
  it('sends with Enter, clears the submitted draft, and preserves Shift+Enter and IME input', async () => {
    const { emitted } = render(TaskComposer, { props: { disabled: false, hint: null } });
    const input = screen.getByRole('textbox', { name: '任务' });
    await fireEvent.update(input, '创建页面');
    await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(emitted().submit).toBeUndefined();
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(emitted().submit).toEqual([['创建页面']]);
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('button', { name: /停止/ })).toBeNull();
  });
  it('preserves the next draft during execution and exposes Stop instead of Send', async () => {
    const { emitted } = render(TaskComposer, { props: { disabled: true, busy: true, hint: null } });
    const input = screen.getByRole('textbox', { name: '任务' });
    await fireEvent.update(input, '下一步');
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(emitted().submit).toBeUndefined();
    expect((input as HTMLTextAreaElement).value).toBe('下一步');
    await fireEvent.click(screen.getByRole('button', { name: /一键停止/ }));
    expect(emitted().cancel).toHaveLength(1);
  });
  it('collapses tool details and treats model HTML as text while rendering inline code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const text = '**已完成**\n打开 `index.html`\n<img src=x onerror=alert(1)>';
    render(ChatFeed, { props: { messages: [
      { role: 'tool', text: '', status: 'done', tool: { id: 'call_1', tool: 'write_file', args: { path: 'index.html', content: '<h1>demo</h1>' } } },
      { role: 'assistant', text },
    ] } });
    expect((document.querySelector('.tool-details') as HTMLDetailsElement).open).toBe(false);
    expect(document.querySelector('.assistant-text strong')?.textContent).toBe('已完成');
    expect(document.querySelector('.assistant-text code')?.textContent).toBe('index.html');
    expect(document.querySelector('img')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: '复制回复' }));
    expect(writeText).toHaveBeenCalledWith(text);
    await screen.findByRole('button', { name: '已复制' });
  });
});
