// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QwenAdapter } from '../../../src/content/adapters/qwen';
import { qwenSelectors } from '../../../src/content/adapters/qwen';
import { GoogleAiStudioAdapter } from '../../../src/content/adapters/google-ai-studio';
import { ChatGptAdapter } from '../../../src/content/adapters/chatgpt';

const documentFor = (kind: 'qwen' | 'google' | 'chatgpt'): Document => {
  document.body.innerHTML = `<main><form><textarea data-${kind}-composer></textarea><button type="button" data-${kind}-send>Send</button></form><section data-${kind}-messages></section></main>`;
  return document;
};

describe('provider adapters', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['hidden', 'aria-label', 'class'] as const)('delivers the complete Qwen snapshot when Stop changes via %s, including a second turn', async (attribute) => {
    vi.useFakeTimers();
    documentFor('qwen');
    const style = document.createElement('style');
    style.textContent = '.stopped { display: none; }';
    document.head.append(style);
    const visible = (element: Element) => Object.defineProperty(element, 'getClientRects', { value: () => [{ width: 1 }] });
    for (const element of document.querySelectorAll('main, form, textarea, button, section')) visible(element);
    const adapter = new QwenAdapter(document);
    try {
      for (const answer of ['<tool_call>{"id":"one","tool":"read_file","args":{"path":"/work/a"}}</tool_call>', '第二轮已完成']) {
        const signal = new AbortController().signal;
        const anchor = await adapter.sendPrompt('continue', signal);
        const stop = document.createElement('button');
        stop.setAttribute('aria-label', 'Stop');
        visible(stop);
        document.querySelector('form')!.append(stop);
        const deltas: string[] = [];
        let done = false;
        const watch = adapter.watchResponse(anchor, signal, delta => deltas.push(delta)).then(() => { done = true; });
        const response = document.createElement('div');
        response.className = 'response-message-content phase-answer';
        response.textContent = '中间态';
        document.querySelector('section')!.append(response);
        await vi.advanceTimersByTimeAsync(2000);
        expect(done).toBe(false);
        expect(deltas).toEqual([]);
        // Qwen can replace the rendered text and later hide/relabel its stop
        // control without inserting or removing any DOM node.
        response.textContent = answer;
        await vi.advanceTimersByTimeAsync(2000);
        expect(done).toBe(false);
        stop.setAttribute(attribute, attribute === 'aria-label' ? 'Send' : attribute === 'class' ? 'stopped' : '');
        await vi.advanceTimersByTimeAsync(1600);
        await watch;
        expect(deltas.join('')).toBe(answer);
        expect(done).toBe(true);
        stop.remove();
      }
    } finally { style.remove(); }
  });

  it.each(['main', 'section'] as const)('recovers a replaced Qwen %s and completes only the current turn', async (container) => {
    vi.useFakeTimers();
    documentFor('qwen');
    const visible = () => {
      for (const element of document.querySelectorAll('main, form, textarea, button, section')) {
        Object.defineProperty(element, 'getClientRects', { configurable: true, value: () => [{ width: 1 }] });
      }
    };
    const history = document.createElement('div');
    history.className = 'response-message-content phase-answer';
    history.textContent = 'previous turn';
    document.querySelector('section')!.append(history);
    visible();
    const adapter = new QwenAdapter(document);
    const abort = new AbortController();
    const anchor = await adapter.sendPrompt('continue', abort.signal);
    const deltas: string[] = [];
    let done = false;
    const watch = adapter.watchResponse(anchor, abort.signal, delta => deltas.push(delta)).then(() => { done = true; });
    try {
      const old = document.querySelector(container)!;
      old.replaceWith(old.cloneNode(true));
      visible();
      await vi.advanceTimersByTimeAsync(2000);
      expect(done).toBe(false);
      expect(deltas).toEqual([]);
      const stop = document.createElement('button');
      stop.setAttribute('aria-label', 'Stop');
      document.querySelector('form')!.append(stop);
      visible();
      const answer = document.createElement('div');
      answer.className = 'response-message-content phase-answer';
      answer.textContent = 'partial';
      document.querySelector('section')!.append(answer);
      await vi.advanceTimersByTimeAsync(2000);
      expect(done).toBe(false);
      answer.textContent = 'complete HTML response';
      stop.remove();
      await vi.advanceTimersByTimeAsync(2000);
      expect(done).toBe(true);
      expect(deltas).toEqual(['complete HTML response']);
      await watch;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      abort.abort();
      await watch.catch(() => {});
    }
  });

  it('captures an answer that becomes selectable between send and watch', async () => {
    vi.useFakeTimers();
    documentFor('qwen');
    for (const element of document.querySelectorAll('main, form, textarea, button, section')) {
      Object.defineProperty(element, 'getClientRects', { value: () => [{ width: 1 }] });
    }
    const answer = document.createElement('div');
    answer.textContent = 'already complete';
    document.querySelector('section')!.append(answer);
    document.querySelector('button')!.addEventListener('click', () => {
      answer.className = 'response-message-content phase-answer';
    });
    const adapter = new QwenAdapter(document);
    const abort = new AbortController();
    const anchor = await adapter.sendPrompt('hello', abort.signal);
    const deltas: string[] = [];
    let done = false;
    const watch = adapter.watchResponse(anchor, abort.signal, delta => deltas.push(delta)).then(() => { done = true; });
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(done).toBe(true);
      expect(deltas).toEqual(['already complete']);
      await watch;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      abort.abort();
      await watch.catch(() => {});
    }
  });

  it('cleans up Qwen polling on abort and does not release a late answer', async () => {
    vi.useFakeTimers();
    documentFor('qwen');
    for (const element of document.querySelectorAll('main, form, textarea, button, section')) {
      Object.defineProperty(element, 'getClientRects', { value: () => [{ width: 1 }] });
    }
    const adapter = new QwenAdapter(document);
    const abort = new AbortController();
    const anchor = await adapter.sendPrompt('hello', abort.signal);
    const delta = vi.fn();
    const watch = adapter.watchResponse(anchor, abort.signal, delta);
    const rejected = expect(watch).rejects.toMatchObject({ code: 'CONTENT_ABORTED' });
    abort.abort();
    await rejected;
    document.querySelector('section')!.innerHTML = '<div class="response-message-content phase-answer">late</div>';
    await vi.advanceTimersByTimeAsync(90_000);
    expect(delta).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prefers Qwen’s observed composer and send controls over generic fallbacks', () => {
    // Break caught: a Qwen page adds another textarea/button and a broad fallback targets the wrong control.
    expect(qwenSelectors.composer[0]).toBe('textarea.message-input-textarea');
    expect(qwenSelectors.send[0]).toBe('button.send-button[aria-label="Send"]');
    expect(qwenSelectors.composerRegion[0]).toBe('.message-input-container');
  });

  it('finds Qwen’s send button after the composer input makes it available', async () => {
    // Break caught: Qwen initially shows a voice control and replaces it with Send only after input.
    document.body.innerHTML = '<main><div class="message-input-container"><textarea class="message-input-textarea"></textarea></div><section data-qwen-messages></section></main>';
    const region = document.querySelector('.message-input-container') as HTMLElement;
    const composer = document.querySelector('textarea') as HTMLTextAreaElement;
    const messages = document.querySelector('section') as HTMLElement;
    for (const element of [region, composer, messages]) {
      Object.defineProperty(element, 'getClientRects', { value: () => [{ width: 1 }] });
    }
    let clicked = false;
    composer.addEventListener('input', () => {
      const send = document.createElement('button');
      send.className = 'send-button';
      send.setAttribute('aria-label', 'Send');
      send.addEventListener('click', () => { clicked = true; });
      Object.defineProperty(send, 'getClientRects', { value: () => [{ width: 1 }] });
      region.append(send);
    }, { once: true });

    await new QwenAdapter(document).sendPrompt('hello', new AbortController().signal);

    expect(composer.value).toBe('hello');
    expect(clicked).toBe(true);
  });

  it('recognizes Qwen’s current final-response container', () => {
    // Break caught: Qwen does not annotate guest responses with the generic
    // assistant role attributes used by other providers.
    expect(qwenSelectors.assistant).toContain('.response-message-content.phase-answer');
  });

  it.each([
    ['qwen', QwenAdapter], ['google', GoogleAiStudioAdapter], ['chatgpt', ChatGptAdapter],
  ] as const)('fills and sends an exact visible composer for %s', async (kind, Adapter) => {
    // Break caught: a provider adapter picks an arbitrary textarea/button or cannot drive its own scoped composer.
    const fixture = documentFor(kind);
    const composer = fixture.querySelector('textarea') as HTMLTextAreaElement;
    const send = fixture.querySelector('button') as HTMLButtonElement;
    const region = fixture.querySelector('form') as HTMLFormElement;
    const messages = fixture.querySelector('section') as HTMLElement;
    const main = fixture.querySelector('main') as HTMLElement;
    let clicked = false;
    send.addEventListener('click', () => { clicked = true; });
    Object.defineProperty(composer, 'getClientRects', { value: () => [{ width: 1 }] });
    Object.defineProperty(send, 'getClientRects', { value: () => [{ width: 1 }] });
    Object.defineProperty(region, 'getClientRects', { value: () => [{ width: 1 }] });
    Object.defineProperty(messages, 'getClientRects', { value: () => [{ width: 1 }] });
    Object.defineProperty(main, 'getClientRects', { value: () => [{ width: 1 }] });

    const controller = new AbortController();
    await new Adapter(fixture).sendPrompt('hello', controller.signal);
    controller.abort();
    expect(composer.value).toBe('hello');
    expect(clicked).toBe(true);
  });
});
