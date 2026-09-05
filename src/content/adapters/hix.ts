import { DeepSeekAdapter, type ChatSelectors } from './deepseek';

/** Selectors observed on the public HIX AI Chat form; all stay scoped to it. */
export const hixSelectors: ChatSelectors = {
  composerRegion: ['form#hix-chat-form'],
  composer: ['[role="textbox"][contenteditable="true"]'],
  send: ['button[type="submit"][title="submit"]'],
  assistantList: ['main'],
  assistant: ['[data-message-author-role="assistant"]', '[data-role="assistant"]'],
  stop: ['button[aria-label="Stop generating"]', 'button[aria-label="Stop"]'],
};

export class HixAdapter extends DeepSeekAdapter {
  constructor(document: Document = window.document) { super(document, hixSelectors); }
}
