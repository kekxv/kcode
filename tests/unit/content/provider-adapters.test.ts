// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { QwenAdapter } from '../../../src/content/adapters/qwen';
import { GoogleAiStudioAdapter } from '../../../src/content/adapters/google-ai-studio';
import { ChatGptAdapter } from '../../../src/content/adapters/chatgpt';

const documentFor = (kind: 'qwen' | 'google' | 'chatgpt'): Document => {
  document.body.innerHTML = `<main><form><textarea data-${kind}-composer></textarea><button type="button" data-${kind}-send>Send</button></form><section data-${kind}-messages></section></main>`;
  return document;
};

describe('provider adapters', () => {
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
