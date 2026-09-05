// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { QwenAdapter } from '../../../src/content/adapters/qwen';
import { qwenSelectors } from '../../../src/content/adapters/qwen';
import { GoogleAiStudioAdapter } from '../../../src/content/adapters/google-ai-studio';
import { ChatGptAdapter } from '../../../src/content/adapters/chatgpt';

const documentFor = (kind: 'qwen' | 'google' | 'chatgpt'): Document => {
  document.body.innerHTML = `<main><form><textarea data-${kind}-composer></textarea><button type="button" data-${kind}-send>Send</button></form><section data-${kind}-messages></section></main>`;
  return document;
};

describe('provider adapters', () => {
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

    await new Adapter(fixture).sendPrompt('hello', new AbortController().signal);
    expect(composer.value).toBe('hello');
    expect(clicked).toBe(true);
  });
});
