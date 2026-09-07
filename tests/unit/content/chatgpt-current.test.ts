// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAssistantTurn } from '../../../src/sidepanel/tool-parser';
import { ChatGptAdapter } from '../../../src/content/adapters/chatgpt';
const fixture = () => {
  document.body.innerHTML = '<main><section class="answers"></section><form><div><textarea class="wcDTda_fallbackTextarea" placeholder="临时聊天"></textarea><div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p><br></p></div></div><button type="button" aria-label="添加文件等"></button><button type="button" aria-label="开始听写"></button><button disabled type="button" class="composer-submit-btn" aria-label="发送提示词"><svg><use href="/cdn/sprites.svg#send-prompt-style-thin"></use></svg></button></form></main>';
  for (const node of document.querySelectorAll('*')) Object.defineProperty(node, 'getClientRects', { configurable: true, value: () => [{ width: 1 }] });
  return new ChatGptAdapter(document);
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('current ChatGPT composer', () => {
  it('selects ProseMirror instead of fallback textarea and waits before clicking the localized Send button', async () => {
    vi.useFakeTimers();
    const adapter = fixture();
    const editor = document.querySelector('#prompt-textarea')!;
    const send = document.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')!;
    const click = vi.fn(); const other = vi.fn();
    send.addEventListener('click', click);
    document.querySelector('[aria-label="开始听写"]')!.addEventListener('click', other);
    editor.addEventListener('input', () => setTimeout(() => { send.disabled = false; }, 100));
    const controller = new AbortController();
    const sending = adapter.sendPrompt('创建一个页面', controller.signal);
    await vi.advanceTimersByTimeAsync(50);
    expect(click).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    const anchor = await sending;
    expect(editor.textContent).toBe('创建一个页面');
    expect(document.querySelector('textarea')!.value).toBe('');
    expect(click).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled();
    const chunks: string[] = [];
    const watch = adapter.watchResponse(anchor, controller.signal, text => chunks.push(text));
    document.querySelector('.answers')!.innerHTML = '<div data-message-author-role="assistant"><p>已完成</p><ul><li>完整结果</li></ul></div>';
    await vi.advanceTimersByTimeAsync(2000); await watch;
    expect(chunks.join('')).toContain('完整结果');
  });
  it('refuses disabled Send rather than clicking dictation or attachments', async () => {
    vi.useFakeTimers(); const adapter = fixture(); const click = vi.fn();
    document.querySelector('form')!.addEventListener('click', click);
    const result = expect(adapter.sendPrompt('test', new AbortController().signal)).rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' });
    await vi.advanceTimersByTimeAsync(1800); await result; expect(click).not.toHaveBeenCalled();
  });
});

describe('ChatGPT conversation continuity', () => {
  it('sends the contract once per actual conversation and again after history is cleared', async () => {
    const adapter = fixture();
    document.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')!.disabled = false;
    const prefix = 'You are kcode, a careful workspace agent.\n## Tool contract\nread_file/write_file\n';
    const send = async (goal: string) => {
      const controller = new AbortController();
      await adapter.sendPrompt(prefix + '## User goal\n' + goal, controller.signal);
      const value = document.querySelector('#prompt-textarea')!.textContent;
      controller.abort();
      return value;
    };
    expect(await send('first')).toBe(prefix.trimEnd() + '\n\n---\n\n## 用户任务\n\nfirst');
    const history = document.createElement('div');
    history.dataset.messageAuthorRole = 'user'; history.textContent = prefix.trimEnd() + '\n\n---\n\n## 用户任务\n\nfirst';
    document.querySelector('.answers')!.append(history);
    const followup = await send('second');
    expect(followup).toContain('external text tool bridge');
    expect(followup).toContain('second');
    expect(followup).not.toContain('## User goal');
    expect(followup).not.toContain('## Tool contract');
    history.remove();
    expect(await send('new conversation')).toBe(prefix.trimEnd() + '\n\n---\n\n## 用户任务\n\nnew conversation');
  });
  it('ignores a quoted contract in assistant history', async () => {
    const adapter = fixture();
    document.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')!.disabled = false;
    const prompt = 'You are kcode, a careful workspace agent.\nRules\n## User goal\nnext';
    const history = document.createElement('div'); history.dataset.messageAuthorRole = 'assistant'; history.textContent = prompt;
    document.querySelector('.answers')!.append(history);
    const controller = new AbortController();
    await adapter.sendPrompt(prompt, controller.signal);
    expect(document.querySelector('#prompt-textarea')!.textContent).toBe(prompt.replace('\n## User goal\n', '\n\n---\n\n## 用户任务\n\n'));
    controller.abort();
  });
  it('waits through reasoning and streaming, then releases only the final tool call once', async () => {
    vi.useFakeTimers();
    const adapter = fixture();
    document.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')!.disabled = false;
    const controller = new AbortController();
    const anchor = await adapter.sendPrompt('edit', controller.signal);
    const chunks: string[] = [];
    let done = false;
    const watch = adapter.watchResponse(anchor, controller.signal, text => chunks.push(text)).then(() => { done = true; });
    const answers = document.querySelector('.answers')!;
    answers.innerHTML = '<article data-testid="conversation-turn-2"><div data-message-author-role="assistant" aria-busy="true">Thinking</div></article>';
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(false);
    const article = answers.querySelector('article')!;
    article.querySelector('[aria-busy]')!.removeAttribute('aria-busy');
    const final = document.createElement('div');
    final.dataset.messageAuthorRole = 'assistant';
    final.innerHTML = '<div class="markdown result-streaming"></div>';
    const call = '<tool_call>{"id":"w1","tool":"write_file","args":{"path":"index.html","content":"hello"}}</tool_call>';
    final.firstElementChild!.textContent = call;
    article.append(final);
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(false); expect(chunks).toEqual([]);
    final.firstElementChild!.classList.remove('result-streaming');
    article.insertAdjacentHTML('beforeend', '<button data-testid="copy-turn-action-button">复制</button>');
    // ChatGPT leaves Send disabled when its composer is empty after completion.
    document.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')!.disabled = true;
    await vi.advanceTimersByTimeAsync(2000);
    await watch;
    expect(chunks).toEqual([call]);
  });
});

describe('ChatGPT complete tool payload', () => {
  it('reads all Markdown blocks and finishes with current-turn actions despite a stale streaming class', async () => {
    vi.useFakeTimers();
    const adapter = fixture();
    document.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')!.disabled = false;
    const controller = new AbortController();
    const anchor = await adapter.sendPrompt('update', controller.signal);
    const chunks: string[] = [];
    const watch = adapter.watchResponse(anchor, controller.signal, text => chunks.push(text));
    const article = document.createElement('article'); article.dataset.testid = 'conversation-turn-10';
    const answer = document.createElement('div'); answer.dataset.messageAuthorRole = 'assistant';
    const body = JSON.stringify({ id: 'full', tool: 'write_file', args: { path: 'index.html', content: '<script>let x=20+i*cell;</script>' } });
    for (const text of ['<tool_call>', body, '</tool_call>']) {
      const block = document.createElement('div'); block.className = 'markdown result-streaming'; block.textContent = text; answer.append(block);
    }
    article.append(answer);
    const copy = document.createElement('button'); copy.dataset.testid = 'copy-turn-action-button';
    Object.defineProperty(copy, 'getClientRects', { value: () => [{ width: 1 }] }); article.append(copy);
    document.querySelector('.answers')!.append(article);
    await vi.advanceTimersByTimeAsync(2000); await watch;
    expect(chunks.join('')).toContain('</tool_call>');
    expect(chunks.join('')).toContain('20+i*cell');
  });
  it('rejects Markdown-damaged operators instead of silently executing altered source', () => {
    const adapter = fixture();
    const answer = document.createElement('div');
    answer.append(document.createTextNode('<tool_call>{"content":"20+i'));
    const em = document.createElement('em'); em.textContent = 'cell'; answer.append(em);
    answer.append(document.createTextNode('"}</tool_call>'));
    const extracted = (adapter as any).responseElement(answer) as Element;
    expect(extracted.textContent).toContain('MARKDOWN_DAMAGED_TOOL_PAYLOAD');
  });
});

it('collects a fenced XML reply when ChatGPT removes old turns and renders an article-only assistant', async () => {
  vi.useFakeTimers();
  const adapter = fixture();
  document.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')!.disabled = false;
  const answers = document.querySelector('.answers')!;
  answers.innerHTML = '<article data-turn="assistant" data-testid="conversation-turn-1"><div data-message-author-role="assistant">old answer</div></article>';
  const controller = new AbortController();
  const anchor = await adapter.sendPrompt('fix', controller.signal);
  const chunks: string[] = [];
  const watch = adapter.watchResponse(anchor, controller.signal, text => chunks.push(text));
  // There is still only one assistant after virtualization, but it is a new turn.
  answers.innerHTML = '<article data-turn="assistant" data-testid="conversation-turn-3"><div class="markdown result-streaming"><pre><div>XML<button>复制代码</button></div><code></code></pre></div><button data-testid="good-response-turn-action-button">赞</button></article>';
  const call = { id: 'call_1', tool: 'bash', args: { cmd: 'ls -la /work', workspace: 'read' } };
  answers.querySelector('code')!.textContent = '<tool_call>' + JSON.stringify(call) + '</tool_call>';
  Object.defineProperty(answers.querySelector('[data-testid="good-response-turn-action-button"]')!, 'getClientRects', { value: () => [{ width: 1 }] });
  await vi.advanceTimersByTimeAsync(2000);
  await watch;
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).not.toContain('XML');
  expect(chunks[0]).not.toContain('复制代码');
  expect(parseAssistantTurn(chunks.join(''))).toEqual({ kind: 'tool', call });
  expect(parseAssistantTurn('```xml\n' + chunks.join('') + '\n```')).toEqual({ kind: 'tool', call });
});
