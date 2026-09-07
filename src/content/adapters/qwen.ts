import { DeepSeekAdapter, type ChatSelectors } from './deepseek';

// Qwen's current guest and signed-in chat UIs render final assistant text in
// `.response-message-content.phase-answer`, without role/data attributes.
export const qwenSelectors: ChatSelectors = { composerRegion: ['.message-input-container', 'main form', '[data-qwen-composer]'], composer: ['textarea.message-input-textarea', 'textarea[data-qwen-composer]', 'textarea', '[contenteditable="true"][role="textbox"]'], send: ['button.send-button[aria-label="Send"]', 'button[data-qwen-send]', 'button[aria-label="Send"]', 'button[aria-label="发送"]'], assistantList: ['[data-qwen-messages]', 'main'], assistant: ['.response-message-content.phase-answer', '[data-message-author-role="assistant"]', '[data-role="assistant"]'], stop: ['button[aria-label="Stop"]', 'button[aria-label="停止"]'] };
export class QwenAdapter extends DeepSeekAdapter {
  readonly allowsSameOriginNavigation = true;
  protected readonly finalSnapshotOnly = true;

  constructor(document: Document = window.document) { super(document, qwenSelectors); }
}
