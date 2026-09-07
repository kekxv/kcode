import { DeepSeekAdapter, isChatElementVisible, type ChatSelectors } from './deepseek';
export const chatGptSelectors: ChatSelectors = {
  composerRegion: ['form:has(#prompt-textarea)', '[data-chatgpt-composer]:not(textarea)', 'div:has(> div > div > #prompt-textarea):has(button.composer-submit-btn)', 'form'],
  composer: ['#prompt-textarea[contenteditable="true"]', '#prompt-textarea', 'textarea[data-chatgpt-composer]', '[contenteditable="true"][role="textbox"]', 'textarea.wcDTda_fallbackTextarea'],
  send: ['button[data-testid="send-button"]', 'button[data-chatgpt-send]', 'button[aria-label="Send"]', 'button[aria-label="Send prompt"]', 'button[aria-label="发送提示词"]', 'button.composer-submit-btn:has(use[href$="#send-prompt-style-thin"])'],
  assistantList: ['main', '[role="main"]'],
  assistant: ['article[data-turn="assistant"]', '[data-message-author-role="assistant"]'],
  stop: ['button[data-testid="stop-button"]', 'button[aria-label="Stop"]', 'button[aria-label="Stop generating"]', 'button[aria-label="停止生成"]'],
};
export class ChatGptAdapter extends DeepSeekAdapter {
  readonly allowsSameOriginNavigation = true;
  protected readonly preferredComposer = true;
  protected readonly finalSnapshotOnly = true;
  protected readonly sendControlWaitMs = 1500;
  protected responseElement(assistant: Element): Element {
    // A single answer can split its opening envelope, code and closing tag
    // across multiple Markdown blocks. Read the complete message.
    if (/<tool_call(?:\s|>)/.test(assistant.textContent ?? '')
      && [...assistant.querySelectorAll('em, strong, del')].some(node => !node.closest('pre, code'))) {
      // Formatting has already discarded source delimiters. Do not guess at
      // lost operators and execute corrupted code; request protocol repair.
      const invalid = assistant.ownerDocument.createElement('div');
      invalid.textContent = '<tool_call>MARKDOWN_DAMAGED_TOOL_PAYLOAD</tool_call>';
      return invalid;
    }
    // Extract source code, excluding the XML language header/copy toolbar.
    const clone = assistant.cloneNode(true) as Element;
    for (const pre of clone.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      if (code) pre.replaceChildren(code);
    }
    return clone;
  }
  protected newResponses(assistants: Element[], existing: ReadonlySet<Element>): Element[] {
    // ChatGPT virtualizes old turns: subtracting the old count can hide the
    // new reply entirely when earlier turns have been removed from the DOM.
    const ids = new Set([...existing].map(node => node.getAttribute('data-message-id')
      ?? node.closest('article')?.getAttribute('data-testid')).filter(Boolean));
    return assistants.filter(node => !existing.has(node) && !ids.has(node.getAttribute('data-message-id')
      ?? node.closest('article')?.getAttribute('data-testid')));
  }
  protected selectResponse(candidates: Element[]): Element | undefined {
    // A ChatGPT turn can contain separate reasoning and final-answer messages.
    // Prefer its last message, while still rejecting unrelated concurrent turns.
    if (candidates.length > 1) {
      const turns = new Set(candidates.map(node => node.closest('article[data-testid^="conversation-turn-"]')));
      if (turns.size !== 1 || turns.has(null)) return super.selectResponse(candidates);
    }
    return candidates.at(-1);
  }
  protected isSnapshotComplete(scope: Element, assistant?: Element): boolean {
    if (!super.isSnapshotComplete(scope)) return false;
    const turn = assistant?.closest('article[data-testid^="conversation-turn-"]') ?? assistant;
    // Only inspect actions on this response, never copy buttons from history.
    const actions = turn?.querySelectorAll('button[data-testid="copy-turn-action-button"], button[aria-label="复制"], button[aria-label="Copy"], button[data-testid="good-response-turn-action-button"], button[data-testid="bad-response-turn-action-button"]');
    if (actions && [...actions].some(action => !action.closest('pre') && isChatElementVisible(action))) return true;
    if (turn?.matches('[data-is-streaming="true"], [aria-busy="true"]')
      || turn?.querySelector('[data-is-streaming="true"], .result-streaming, [aria-busy="true"]')) return false;
    return super.isSnapshotComplete(scope);
  }
  protected writeEditable(composer: HTMLElement, prompt: string): void {
    composer.focus();
    // Native editing notifies ProseMirror's editor state, unlike only mutating textContent.
    const document = composer.ownerDocument;
    const selection = document.getSelection();
    const range = document.createRange(); range.selectNodeContents(composer);
    selection?.removeAllRanges(); selection?.addRange(range);
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, prompt)) return;
    super.writeEditable(composer, prompt);
  }
  constructor(document: Document = window.document) { super(document, chatGptSelectors); }
}
