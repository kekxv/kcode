// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterForOrigin } from '../../../src/content/adapters/registry';
import currentComposer from '../../fixtures/deepseek-current-composer.html?raw';

const fixture = () => {
  // Structural fallback fixture, not a captured authenticated DeepSeek DOM.
  document.body.innerHTML = '<div id="app"><div class="ds-textarea"><textarea id="chat-input" placeholder="给 DeepSeek 发送消息"></textarea><div class="toolbar"><div role="button" tabindex="0">深度思考</div><div role="button" tabindex="0">智能搜索</div><div role="button" tabindex="0">附件</div><div role="button" tabindex="0"><svg><path d="M0 0" /></svg></div></div></div><div class="answers"></div></div>';
  for (const element of document.querySelectorAll('body, div, textarea')) {
    Object.defineProperty(element, 'getClientRects', { configurable: true, value: () => [{ width: 1 }] });
  }
  return adapterForOrigin('https://chat.deepseek.com', document)!;
};
afterEach(() => vi.useRealTimers());

describe('DeepSeek page compatibility', () => {

  it('keeps the complete final snapshot when Markdown rewrites a streamed prefix and replaces the answer node', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = currentComposer;
    for (const node of document.querySelectorAll('body, div, textarea')) Object.defineProperty(node, 'getClientRects', { configurable: true, value: () => [{ width: 1 }] });
    const send = document.querySelector('.ds-button--circle')!;
    const arrow = send.querySelector('path')!;
    const arrowPath = arrow.getAttribute('d')!;
    send.classList.remove('ds-button--disabled');
    send.addEventListener('click', () => arrow.setAttribute('d', 'M0 0H16V16H0Z'));
    const adapter = adapterForOrigin('https://chat.deepseek.com', document)!;
    const abort = new AbortController();
    const anchor = await adapter.sendPrompt('创建并验证 HTML', abort.signal);
    const deltas: string[] = [];
    let done = false;
    const watching = adapter.watchResponse(anchor, abort.signal, delta => deltas.push(delta)).then(() => { done = true; });
    const answers = document.querySelector('.answers')!;
    answers.innerHTML = '<div class="ds-markdown">HTML demo项目已成功创建并验证完成。总结</div>';
    await vi.advanceTimersByTimeAsync(1800);
    expect(done).toBe(false); expect(deltas).toEqual([]);
    answers.innerHTML = '<div class="ds-markdown"><p>HTML demo项目已成功创建并验证完成。</p><h2>总结：</h2><ul><li>文件已创建</li><li>交互功能已实现</li></ul><p>可以打开 index.html 查看效果。</p><button>复制</button></div>';
    await vi.advanceTimersByTimeAsync(1800);
    expect(done).toBe(false);
    send.classList.add('ds-button--disabled');
    arrow.setAttribute('d', arrowPath);
    await vi.advanceTimersByTimeAsync(1800);
    await watching;
    expect(deltas.join('')).toBe('HTML demo项目已成功创建并验证完成。\n总结：\n• 文件已创建\n• 交互功能已实现\n可以打开 index.html 查看效果。');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for the send arrow to return and completes even when the empty composer disables it', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = currentComposer;
    for (const node of document.querySelectorAll('body, div, textarea')) {
      Object.defineProperty(node, 'getClientRects', { configurable: true, value: () => [{ width: 1 }] });
    }
    const send = document.querySelector('.ds-button--circle')!;
    const arrow = send.querySelector('path')!;
    const arrowPath = arrow.getAttribute('d')!;
    send.classList.remove('ds-button--disabled');
    send.addEventListener('click', () => arrow.setAttribute('d', 'M0 0H16V16H0Z'));
    const adapter = adapterForOrigin('https://chat.deepseek.com', document)!;
    const abort = new AbortController();
    const anchor = await adapter.sendPrompt('hello', abort.signal);
    let done = false;
    const watch = adapter.watchResponse(anchor, abort.signal, () => {}).then(() => { done = true; });
    document.querySelector('.answers')!.innerHTML = '<div class="ds-markdown">完整回复</div>';
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(false);
    send.classList.add('ds-button--disabled');
    arrow.setAttribute('d', arrowPath);
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(true);
    await watch;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fills the supplied ID-less composer, waits for class-enabled Send, then clicks only its arrow', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = currentComposer;
    for (const node of document.querySelectorAll('body, div, textarea')) {
      Object.defineProperty(node, 'getClientRects', { configurable: true, value: () => [{ width: 1 }] });
    }
    const adapter = adapterForOrigin('https://chat.deepseek.com', document)!;
    const composer = document.querySelector('textarea')!;
    const send = document.querySelector('.ds-button--circle')!;
    const attachment = document.querySelector('.ds-button--capsule')!;
    const click = vi.fn(); const attach = vi.fn(); const key = vi.fn();
    send.addEventListener('click', click);
    attachment.addEventListener('click', attach);
    composer.addEventListener('keydown', key);
    composer.addEventListener('input', () => setTimeout(() => send.classList.remove('ds-button--disabled'), 75));
    const abort = new AbortController();
    const sending = adapter.sendPrompt('给我创建一个 HTML demo', abort.signal);
    await vi.advanceTimersByTimeAsync(50);
    expect(composer.value).toBe('给我创建一个 HTML demo');
    expect(click).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await sending;
    expect(click).toHaveBeenCalledOnce();
    expect(attach).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sends via Enter without clicking unlabelled toolbar icons and reads the response', async () => {
    vi.useFakeTimers();
    const adapter = fixture();
    const controller = new AbortController();
    const click = vi.fn();
    for (const button of document.querySelectorAll('[role="button"]')) button.addEventListener('click', click);
    const textarea = document.querySelector('textarea')!;
    const keys: string[] = [];
    textarea.addEventListener('keydown', event => {
      keys.push(event.key);
      expect(textarea.value).toBe('创建 HTML');
      const answer = document.createElement('div');
      answer.className = 'ds-markdown';
      answer.textContent = '收到请求';
      document.querySelector('.answers')!.append(answer);
    });
    const anchor = await adapter.sendPrompt('创建 HTML', controller.signal);
    const deltas: string[] = [];
    const watching = adapter.watchResponse(anchor, controller.signal, text => deltas.push(text));
    await vi.advanceTimersByTimeAsync(2000);
    await watching;
    expect(keys).toEqual(['Enter']);
    expect(click).not.toHaveBeenCalled();
    expect(deltas.join('')).toBe('收到请求');
    expect(adapter.allowsSameOriginNavigation).toBe(true);
  });

  it('uses a labelled role button instead of keyboard fallback', async () => {
    const adapter = fixture();
    const send = document.querySelector('[role="button"]')!;
    send.setAttribute('aria-label', '发送');
    const click = vi.fn();
    const key = vi.fn();
    send.addEventListener('click', click);
    document.querySelector('textarea')!.addEventListener('keydown', key);
    const abort = new AbortController();
    await adapter.sendPrompt('hello', abort.signal);
    expect(click).toHaveBeenCalledOnce();
    expect(key).not.toHaveBeenCalled();
    abort.abort();
  });

  it.each(['disabled', 'ambiguous'] as const)('does not bypass a %s labelled send control', async kind => {
    const adapter = fixture();
    const buttons = [...document.querySelectorAll('[role="button"]')];
    buttons[0].setAttribute('aria-label', '发送');
    if (kind === 'disabled') buttons[0].setAttribute('aria-disabled', 'true');
    else buttons[1].setAttribute('aria-label', '发送');
    const key = vi.fn();
    document.querySelector('textarea')!.addEventListener('keydown', key);
    await expect(adapter.sendPrompt('hello', new AbortController().signal)).rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' });
    expect(key).not.toHaveBeenCalled();
  });
});

it('collects a repair response after all old Markdown nodes are removed', async () => {
  vi.useFakeTimers(); const adapter = fixture();
  const answers = document.querySelector('.answers')!;
  answers.innerHTML = '<div class="ds-markdown">old invalid answer</div>';
  const controller = new AbortController();
  const anchor = await adapter.sendPrompt('Correct the previous XML', controller.signal);
  const chunks: string[] = [];
  const watch = adapter.watchResponse(anchor, controller.signal, text => chunks.push(text));
  answers.innerHTML = '<div class="ds-markdown"><pre><div>XML<button>复制</button></div><code></code></pre></div>';
  const call = '<tool_call>{"id":"read_1","tool":"read_file","args":{"path":"index.html"}}</tool_call>';
  answers.querySelector('code')!.textContent = call;
  await vi.advanceTimersByTimeAsync(2000); await watch;
  expect(chunks).toEqual([call]);
  expect(vi.getTimerCount()).toBe(0);
});
