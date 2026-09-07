// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { GoogleAiStudioAdapter } from '../../../src/content/adapters/google-ai-studio';
import { parseAssistantTurn } from '../../../src/sidepanel/tool-parser';
import { longToolCall, longToolEnvelope } from '../../helpers/long-tool-envelope';
const fixture = readFileSync('tests/fixtures/google-ai-studio-current-composer.html', 'utf8');
const visible = (node: Element) => Object.defineProperty(node, 'getClientRects', { configurable: true, value: () => [{ width: 1 }] });
const setup = () => { document.body.innerHTML = fixture; document.querySelectorAll('*').forEach(visible); return new GoogleAiStudioAdapter(document); };
afterEach(() => vi.useRealTimers());
it('uses the provided composer and unlabelled Run button, never adjacent controls', async () => {
  const adapter = setup();
  const clicks = new Map([...document.querySelectorAll('button')].map(button => { const spy = vi.fn(); button.addEventListener('click', spy); return [button, spy]; }));
  const input = vi.fn(); document.querySelector('.prompt-box-container textarea')!.addEventListener('input', input);
  const abort = new AbortController();
  await adapter.sendPrompt('检查当前项目', abort.signal);
  expect((document.querySelector('.prompt-box-container textarea') as HTMLTextAreaElement).value).toBe('检查当前项目');
  expect((document.querySelector('textarea[aria-label]') as HTMLTextAreaElement).value).toBe('');
  expect(input).toHaveBeenCalledOnce();
  for (const [button, click] of clicks) expect(click).toHaveBeenCalledTimes(button.matches('.ctrl-enter-submits') ? 1 : 0);
  abort.abort();
});
it('fails closed when the Run button is disabled or ambiguous', async () => {
  vi.useFakeTimers();
  const adapter = setup();
  const send = document.querySelector('.ctrl-enter-submits') as HTMLButtonElement;
  send.disabled = true;
  const click = vi.fn(); send.addEventListener('click', click);
  const failed = expect(adapter.sendPrompt('goal', new AbortController().signal)).rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' });
  await vi.advanceTimersByTimeAsync(3100); await failed;
  expect(click).not.toHaveBeenCalled();
  send.disabled = false;
  const duplicate = send.cloneNode(true) as Element; visible(duplicate); send.after(duplicate);
  await expect(adapter.sendPrompt('goal', new AbortController().signal)).rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' });
});
it('reads the final long escaped JSON snapshot without duplicating rewritten streaming text', async () => {
  vi.useFakeTimers();
  const adapter = setup(); const abort = new AbortController();
  const anchor = await adapter.sendPrompt('write HTML', abort.signal);
  const run = document.querySelector('.ctrl-enter-submits')!; run.textContent = 'stop Stop';
  const deltas: string[] = [];
  const watch = adapter.watchResponse(anchor, abort.signal, text => deltas.push(text));
  const response = document.createElement('div'); response.className = 'model-prompt-container'; visible(response);
  const code = document.createElement('code'); response.append(code); document.querySelector('ms-chat-session')!.append(response);
  code.textContent = longToolEnvelope().slice(0, 40_001);
  await vi.advanceTimersByTimeAsync(2000); expect(deltas).toEqual([]);
  code.textContent = longToolEnvelope();
  run.textContent = 'Run';
  await vi.advanceTimersByTimeAsync(2000); await watch;
  expect(deltas.length).toBeGreaterThan(1);
  expect(deltas.join('')).toBe(longToolEnvelope());
  expect(parseAssistantTurn(deltas.join(''))).toEqual({ kind: 'tool', call: longToolCall() });
});

// User supplied only a prompt-box subtree. No response container is guaranteed
// on AI Studio's empty/new-chat page, unlike the original test fixture.
it('sends from the supplied prompt-box alone without main or an existing conversation', async () => {
  const adapter = setup();
  const promptBox = document.querySelector('.prompt-box-container')!;
  document.body.replaceChildren(promptBox);
  const click = vi.fn(); promptBox.querySelector('.ctrl-enter-submits')!.addEventListener('click', click);
  const abort = new AbortController();
  await adapter.sendPrompt('首次发送', abort.signal);
  expect(click).toHaveBeenCalledOnce();
  expect((promptBox.querySelector('textarea') as HTMLTextAreaElement).value).toBe('首次发送');
  abort.abort();
});
it('waits for Angular to create the Run control after the input event', async () => {
  vi.useFakeTimers();
  const adapter = setup(); const run = document.querySelector('.ctrl-enter-submits')!;
  const parent = run.parentElement!; run.remove();
  const click = vi.fn(); run.addEventListener('click', click);
  document.querySelector('.prompt-box-container textarea')!.addEventListener('input', () => setTimeout(() => parent.append(run), 500));
  const abort = new AbortController();
  const sending = adapter.sendPrompt('延迟控件', abort.signal);
  await vi.advanceTimersByTimeAsync(600); await sending;
  expect(click).toHaveBeenCalledOnce(); abort.abort();
});
it('reports the exact failing stage when the Run button is unavailable', async () => {
  vi.useFakeTimers(); const adapter = setup();
  (document.querySelector('.ctrl-enter-submits') as HTMLButtonElement).disabled = true;
  const failed = expect(adapter.sendPrompt('goal', new AbortController().signal)).rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED', message: expect.stringContaining('发送前 · 发送按钮（可见 1 个；0 个可用') });
  await vi.advanceTimersByTimeAsync(3100); await failed;
});

it.each(['ms-thought-chunk', 'section'])('waits through %s thoughts and reads a sibling XML block from the whole turn', async tag => {
  vi.useFakeTimers(); const adapter = setup(); const abort = new AbortController();
  const anchor = await adapter.sendPrompt('创建 demo', abort.signal);
  const deltas: string[] = []; let done = false;
  const watch = adapter.watchResponse(anchor, abort.signal, delta => deltas.push(delta)).then(() => { done = true; });
  const turn = document.createElement('ms-chat-turn');
  turn.innerHTML = `<div class="model-prompt-container"><span>Model 09:29</span><${tag}><h3>Thoughts</h3><div>Expand to view model thoughts</div><ms-cmark-node>正在思考</ms-cmark-node><code>do not execute this thought</code></${tag}></div>`;
  document.querySelector('ms-chat-session')!.append(turn);
  await vi.advanceTimersByTimeAsync(6000);
  expect(done).toBe(false); expect(deltas).toEqual([]);
  const body = document.createElement('ms-cmark-node');
  body.innerHTML = '<ms-code-block><div class="code-block-header">Xml <button>Copy</button></div><pre><code></code></pre></ms-code-block>';
  const payload = '<tool_call>{"id":"call_1","tool":"bash","args":{"cmd":"ls -la /work","workspace":"read"}}</tool_call>';
  body.querySelector('code')!.textContent = payload;
  turn.append(body);
  await vi.advanceTimersByTimeAsync(2000); await watch;
  expect(deltas.join('')).toBe(payload);
  expect(parseAssistantTurn(deltas.join(''))).toMatchObject({ kind: 'tool', call: { id: 'call_1' } });
});
it('retains plain final prose after thoughts, including the word Thoughts inside code', async () => {
  vi.useFakeTimers(); const adapter = setup(); const abort = new AbortController();
  const anchor = await adapter.sendPrompt('goal', abort.signal);
  const deltas: string[] = []; const watch = adapter.watchResponse(anchor, abort.signal, delta => deltas.push(delta));
  const turn = document.createElement('ms-chat-turn');
  turn.innerHTML = '<div class="model-prompt-container">Model 09:29<ms-thought-chunk>正在思考</ms-thought-chunk></div><ms-cmark-node><p>已创建页面。</p><pre><code>Thoughts</code></pre></ms-cmark-node>';
  document.querySelector('ms-chat-session')!.append(turn);
  await vi.advanceTimersByTimeAsync(2000); await watch;
  expect(deltas.join('')).toBe('已创建页面。\nThoughts');
});

it.each(['disabled', 'aria-disabled'])('completes direct XML replies with an empty composer and %s Run, across two turns', async disabled => {
  vi.useFakeTimers(); const adapter = setup();
  const run = document.querySelector('.ctrl-enter-submits') as HTMLButtonElement;
  const composer = document.querySelector('.prompt-box-container textarea') as HTMLTextAreaElement;
  for (let index = 1; index <= 2; index++) {
    run.removeAttribute(disabled);
    const abort = new AbortController();
    const anchor = await adapter.sendPrompt('continue', abort.signal);
    composer.value = ''; run.textContent = 'Run ⌘ ↵'; run.setAttribute(disabled, 'true');
    const deltas: string[] = []; let done = false;
    const watch = adapter.watchResponse(anchor, abort.signal, delta => deltas.push(delta)).then(() => { done = true; });
    const turn = document.createElement('ms-chat-turn');
    turn.innerHTML = '<div class="model-prompt-container">Model 09:35</div><ms-cmark-node><pre><code></code></pre></ms-cmark-node>';
    const call = { id: `call_${index}`, tool: 'bash', args: { cmd: 'ls -la /work', workspace: 'read' } };
    const payload = '<tool_call>' + JSON.stringify(call) + '</tool_call>';
    turn.querySelector('code')!.textContent = payload;
    document.querySelector('ms-chat-session')!.append(turn);
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(true); await watch;
    expect(deltas.join('')).toBe(payload);
    expect(parseAssistantTurn(deltas.join(''))).toEqual({ kind: 'tool', call });
    expect(vi.getTimerCount()).toBe(0);
  }
});
it.each(['stop', 'busy'])('still waits for the explicit %s signal to clear when Run is disabled', async state => {
  vi.useFakeTimers(); const adapter = setup(); const abort = new AbortController();
  const anchor = await adapter.sendPrompt('goal', abort.signal);
  const run = document.querySelector('.ctrl-enter-submits') as HTMLButtonElement;
  run.disabled = true;
  run.textContent = state === 'stop' ? 'stop Stop' : 'Run';
  if (state === 'busy') run.setAttribute('aria-busy', 'true');
  const deltas: string[] = []; let done = false;
  const watch = adapter.watchResponse(anchor, abort.signal, delta => deltas.push(delta)).then(() => { done = true; });
  const turn = document.createElement('ms-chat-turn');
  turn.innerHTML = '<div class="model-prompt-container">Model 09:35</div><ms-cmark-node>尚未结束的正文</ms-cmark-node>';
  document.querySelector('ms-chat-session')!.append(turn);
  await vi.advanceTimersByTimeAsync(4000);
  expect(done).toBe(false); expect(deltas).toEqual([]);
  turn.querySelector('ms-cmark-node')!.textContent = '最终正文';
  run.textContent = 'Run'; run.removeAttribute('aria-busy');
  await vi.advanceTimersByTimeAsync(2000); await watch;
  expect(deltas).toEqual(['最终正文']);
});

it('reads a third edit reply when old turns remount and a hidden highlighted copy is inserted', async () => {
  vi.useFakeTimers(); const adapter = setup();
  const list = document.querySelector('ms-chat-session')!;
  list.replaceChildren();
  const calls = [
    { id: 'call_1', tool: 'bash', args: { cmd: 'ls -la /work', workspace: 'read' } },
    { id: 'call_2', tool: 'read_file', args: { path: 'index.html' } },
    { id: 'call_3', tool: 'edit_file', args: { path: 'index.html', old_string: '<style>body{font-family:Arial}</style>', new_string: '<style>body{background:linear-gradient(135deg,#fdfbfb,#ebedee)}</style>' } },
  ];
  for (const [index, call] of calls.entries()) {
    const abort = new AbortController(); const anchor = await adapter.sendPrompt('continue', abort.signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, abort.signal, delta => deltas.push(delta));
    if (index === 2) {
      // Reinsert a historical rendering before the last stable historical turn.
      list.prepend(list.firstElementChild!.cloneNode(true));
    }
    const turn = document.createElement('ms-chat-turn');
    turn.innerHTML = '<div class="model-prompt-container">Model</div><ms-cmark-node><pre><code></code></pre></ms-cmark-node>';
    const code = turn.querySelector('code')!;
    const payload = '<tool_call>' + JSON.stringify(call) + '</tool_call>';
    code.textContent = payload.slice(0, 40); list.append(turn);
    const hidden = turn.cloneNode(true) as Element; hidden.setAttribute('aria-hidden', 'true'); list.append(hidden);
    await vi.advanceTimersByTimeAsync(500);
    code.replaceChildren(document.createElement('span')); code.firstChild!.textContent = payload;
    await vi.advanceTimersByTimeAsync(2000); await watch;
    expect(deltas.join('')).toBe(payload);
    expect(parseAssistantTurn(deltas.join(''))).toEqual({ kind: 'tool', call });
    hidden.remove();
  }
});
it('reports a precise ambiguity instead of executing one of two distinct new replies', async () => {
  vi.useFakeTimers(); const adapter = setup(); const abort = new AbortController();
  const anchor = await adapter.sendPrompt('goal', abort.signal);
  const watch = adapter.watchResponse(anchor, abort.signal, () => {});
  const failed = expect(watch).rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED', message: expect.stringContaining('读取回复 · 发现 2 个新回复节点') });
  for (const text of ['reply A', 'reply B']) {
    const turn = document.createElement('ms-chat-turn');
    turn.innerHTML = '<div class="model-prompt-container">Model</div><ms-cmark-node></ms-cmark-node>';
    turn.querySelector('ms-cmark-node')!.textContent = text;
    document.querySelector('ms-chat-session')!.append(turn);
  }
  await vi.advanceTimersByTimeAsync(10); await failed;
});

it.each(['role', 'header', 'echo'])('excludes a user turn identified by %s even when it shares the model wrapper', async identification => {
  vi.useFakeTimers(); const adapter = setup(); const abort = new AbortController();
  const prompt = '<tool_call>{"id":"example","tool":"bash","args":{"cmd":"echo example","workspace":"read"}}</tool_call>';
  const anchor = await adapter.sendPrompt(prompt, abort.signal);
  const deltas: string[] = []; const watch = adapter.watchResponse(anchor, abort.signal, text => deltas.push(text));
  const user = document.createElement('ms-chat-turn');
  user.innerHTML = `<div class="model-prompt-container">${identification === 'header' ? 'User • 09:45' : ''}</div><ms-cmark-node></ms-cmark-node>`;
  if (identification === 'role') user.setAttribute('data-role', 'user');
  user.querySelector('ms-cmark-node')!.textContent = identification === 'echo' ? prompt : 'Do not execute the example tool in this user turn.';
  const model = document.createElement('ms-chat-turn');
  model.innerHTML = '<div class="model-prompt-container">Model</div><ms-cmark-node><code></code></ms-cmark-node>';
  const payload = '<tool_call>{"id":"actual","tool":"read_file","args":{"path":"index.html"}}</tool_call>';
  model.querySelector('code')!.textContent = payload;
  document.querySelector('ms-chat-session')!.append(user, model);
  await vi.advanceTimersByTimeAsync(2000); await watch;
  expect(deltas.join('')).toBe(payload);
  expect(parseAssistantTurn(deltas.join(''))).toMatchObject({ kind: 'tool', call: { id: 'actual' } });
});
it('selects the final body when thought-only and answer blocks are separate ms-chat-turn nodes', async () => {
  vi.useFakeTimers(); const adapter = setup(); const abort = new AbortController();
  const anchor = await adapter.sendPrompt('goal', abort.signal);
  const deltas: string[] = []; const watch = adapter.watchResponse(anchor, abort.signal, text => deltas.push(text));
  const thought = document.createElement('ms-chat-turn');
  thought.innerHTML = '<div class="model-prompt-container">Model</div><ms-thought-chunk><ms-cmark-node>正在思考</ms-cmark-node></ms-thought-chunk>';
  document.querySelector('ms-chat-session')!.append(thought);
  await vi.advanceTimersByTimeAsync(3000); expect(deltas).toEqual([]);
  const answer = document.createElement('ms-chat-turn');
  answer.innerHTML = '<div class="model-prompt-container">Model</div><ms-cmark-node>最终答复</ms-cmark-node>';
  thought.after(answer);
  await vi.advanceTimersByTimeAsync(2000); await watch;
  expect(deltas).toEqual(['最终答复']);
});

it.each([
  ['separate', 'true'], ['separate', 'false'], ['same', 'true'], ['same', 'false'],
])('excludes the supplied Material Thoughts panel (%s turn, expanded=%s)', async (layout, expanded) => {
  vi.useFakeTimers(); const adapter = setup(); const abort = new AbortController();
  const anchor = await adapter.sendPrompt('goal', abort.signal);
  const deltas: string[] = []; let done = false;
  const watch = adapter.watchResponse(anchor, abort.signal, text => deltas.push(text)).then(() => { done = true; });
  const thought = document.createElement('ms-chat-turn');
  thought.innerHTML = `<div class="model-prompt-container">Model 09:45</div>
    <mat-expansion-panel class="mat-expansion-panel">
      <mat-expansion-panel-header aria-expanded="${expanded}">
        <mat-panel-title _ngcontent-ng-c3441155968="" class="mat-expansion-panel-header-title top-panel-title"><img _ngcontent-ng-c3441155968="" src="https://www.gstatic.com/aistudio/watermark/watermark.png" alt="Thinking" class="thinking-progress-icon ng-tns-c3441155968-9"><!----> Thoughts <!----></mat-panel-title>
      </mat-expansion-panel-header>
      <div class="mat-expansion-panel-content"><ms-cmark-node>我正在考虑以下调用<pre><code></code></pre></ms-cmark-node></div>
    </mat-expansion-panel>`;
  thought.querySelector('code')!.textContent = '<tool_call>{"id":"thought_only","tool":"bash","args":{"cmd":"echo thought","workspace":"read"}}</tool_call>';
  document.querySelector('ms-chat-session')!.append(thought);
  await vi.advanceTimersByTimeAsync(3000);
  expect(done).toBe(false); expect(deltas).toEqual([]);
  const answer = layout === 'same' ? thought : document.createElement('ms-chat-turn');
  if (layout !== 'same') { answer.innerHTML = '<div class="model-prompt-container">Model 09:45</div>'; thought.after(answer); }
  const body = document.createElement('ms-cmark-node'); body.innerHTML = '<pre><code></code></pre>';
  const payload = '<tool_call>{"id":"actual","tool":"read_file","args":{"path":"index.html"}}</tool_call>';
  body.querySelector('code')!.textContent = payload; answer.append(body);
  await vi.advanceTimersByTimeAsync(2000); await watch;
  expect(deltas.join('')).toBe(payload);
  expect(parseAssistantTurn(deltas.join(''))).toMatchObject({ kind: 'tool', call: { id: 'actual' } });
});

const rateLimitNode = () => {
  const node = document.createElement('div');
  node.className = 'model-error ng-star-inserted';
  node.innerHTML = '<span aria-hidden="true" class="material-symbols-outlined notranslate"> error </span><span> You\'ve reached your rate limit. Please try again later. </span>';
  visible(node); return node;
};
it.each([0, 180_000])('reports AI Studio rate limiting after %s ms without releasing answer text', async delay => {
  vi.useFakeTimers(); const adapter = setup(); const abort = new AbortController();
  const anchor = await adapter.sendPrompt('goal', abort.signal);
  const deltas: string[] = [];
  const watch = adapter.watchResponse(anchor, abort.signal, text => deltas.push(text));
  const failed = expect(watch).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', message: 'AI Studio 已达到速率限制，请稍后重试。' });
  await vi.advanceTimersByTimeAsync(delay);
  document.querySelector('ms-chat-session')!.append(rateLimitNode());
  await vi.advanceTimersByTimeAsync(300); await failed;
  expect(deltas).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});
it('catches an error rendered synchronously by Run before observation begins', async () => {
  const adapter = setup(); const abort = new AbortController();
  document.querySelector('.ctrl-enter-submits')!.addEventListener('click', () => document.body.append(rateLimitNode()));
  const anchor = await adapter.sendPrompt('goal', abort.signal);
  await expect(adapter.watchResponse(anchor, abort.signal, () => {})).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
});
it('ignores a previous visible error but detects a hidden error when it becomes visible', async () => {
  vi.useFakeTimers(); const adapter = setup(); const abort = new AbortController();
  const old = rateLimitNode(); const current = rateLimitNode(); current.hidden = true;
  document.body.append(old, current);
  const anchor = await adapter.sendPrompt('retry', abort.signal);
  const watch = adapter.watchResponse(anchor, abort.signal, () => {});
  const failed = expect(watch).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
  await vi.advanceTimersByTimeAsync(3000);
  current.hidden = false;
  await vi.advanceTimersByTimeAsync(300); await failed;
  expect(vi.getTimerCount()).toBe(0);
});
it('reports other explicit model errors with their message', async () => {
  const adapter = setup(); const abort = new AbortController();
  const anchor = await adapter.sendPrompt('goal', abort.signal);
  const error = rateLimitNode(); error.querySelector('span:last-child')!.textContent = 'Model unavailable. Try again later.';
  document.body.append(error);
  await expect(adapter.watchResponse(anchor, abort.signal, () => {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: 'AI Studio 返回错误：Model unavailable. Try again later.' });
});
