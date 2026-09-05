import { DeepSeekAdapter, type ChatSelectors } from './deepseek';

/** Selectors scoped to EaseMate's anonymous AI chat card. */
export const easemateSelectors: ChatSelectors = {
  composerRegion: ['.ai-chat-input-wrapper'],
  composer: ['textarea.input-textarea'],
  send: ['button[aria-label="Send Message"]'],
  assistantList: ['.message-area'],
  assistant: ['.answer-message-content'],
  stop: ['button[aria-label="Stop generating"]', 'button[aria-label="Stop"]'],
};

export class EasemateAdapter extends DeepSeekAdapter {
  constructor(document: Document = window.document) { super(document, easemateSelectors); }
}
