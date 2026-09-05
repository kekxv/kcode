import { DeepSeekAdapter, type ChatSelectors } from './deepseek';

/** Selectors observed on Gemini's public chat composer after the input is focused. */
export const geminiSelectors: ChatSelectors = {
  composerRegion: ['rich-textarea'],
  composer: ['.ql-editor[contenteditable="true"][role="textbox"][aria-label="Enter a prompt for Gemini"]'],
  send: ['button[aria-label="Send message"]'],
  assistantList: ['main'],
  assistant: ['model-response'],
  stop: ['button[aria-label="Stop response"]'],
};

export class GeminiAdapter extends DeepSeekAdapter {
  constructor(document: Document = window.document) { super(document, geminiSelectors); }
}
