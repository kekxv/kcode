// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EasemateAdapter } from '../../../src/content/adapters/easemate';

const visible = (element: Element): void => {
  Object.defineProperty(element, 'getClientRects', { configurable: true, value: () => [{ width: 1, height: 1 }] });
};

describe('EasemateAdapter', () => {
  it('sends only through the scoped anonymous chat composer', async () => {
    // Break caught: selecting a marketing-page textarea or unrelated button sends a kcode prompt outside the chat session.
    document.body.innerHTML = `
      <textarea id="newsletter"></textarea>
      <div class="message-area"><div class="answer-message-content">earlier response</div></div>
      <div class="ai-chat-input-wrapper"><textarea class="input-textarea"></textarea><button aria-label="Send Message"></button></div>`;
    for (const element of document.querySelectorAll('textarea, button, .ai-chat-input-wrapper, .message-area')) visible(element);
    const send = document.querySelector('button')!;
    const click = vi.fn();
    send.addEventListener('click', click);

    const anchor = await new EasemateAdapter(document).sendPrompt('write a file', new AbortController().signal);

    expect((document.querySelector('.input-textarea') as HTMLTextAreaElement).value).toBe('write a file');
    expect((document.querySelector('#newsletter') as HTMLTextAreaElement).value).toBe('');
    expect(click).toHaveBeenCalledOnce();
    expect(anchor.existingAssistantNodes.size).toBe(1);
  });
});
