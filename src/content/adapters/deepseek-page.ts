import { DeepSeekAdapter, deepSeekSelectors, isChatElementVisible, type ChatSelectors } from './deepseek';

const sendArrow = '.ds-button--primary.ds-button--circle:has(svg path[d^="M8.3125 0.981587"])';

// Keep legacy/test selectors, then recognize the provider-specific composer.
// Avoid generated class hashes and positional guesses among toolbar icons.
export const deepSeekPageSelectors: ChatSelectors = {
  composerRegion: [
    ...deepSeekSelectors.composerRegion,
    '.ds-textarea:has(textarea)',
    'div:has(> div > textarea[placeholder*="DeepSeek"]):has(.ds-button--primary.ds-button--circle)',
    'body:has(textarea#chat-input)',
    'body:has(textarea[placeholder*="DeepSeek"])',
  ],
  composer: ['textarea#chat-input', 'textarea[placeholder*="DeepSeek"]', ...deepSeekSelectors.composer],
  send: [
    ...deepSeekSelectors.send,
    '[role="button"][aria-label="发送"]', '[role="button"][aria-label="Send"]',
    '[role="button"][aria-label="发送消息"]', 'button[aria-label="发送消息"]',
    '[role="button"][title="发送"]', 'button[title="发送"]',
    // Arrow path observed in the supplied chat DOM; never select the adjacent
    // paperclip or infer Send from toolbar position/generated class hashes.
    sendArrow,
  ],
  assistantList: ['main', '[role="main"]', 'body'],
  assistant: deepSeekSelectors.assistant,
  stop: [
    ...deepSeekSelectors.stop,
    '[role="button"][aria-label="停止"]', '[role="button"][aria-label="Stop"]',
    '[role="button"][aria-label="停止生成"]', 'button[aria-label="停止生成"]',
  ],
};

export class DeepSeekPageAdapter extends DeepSeekAdapter {
  readonly allowsSameOriginNavigation = true;
  protected readonly finalSnapshotOnly = true;

  protected newResponses(assistants: Element[], existing: ReadonlySet<Element>): Element[] {
    // Prefer node identity when history is still mounted; old turns may be
    // removed between the invalid response and its repair response.
    if ([...existing].some(node => node.isConnected)) return assistants.filter(node => !existing.has(node));
    if (assistants.length > existing.size) return super.newResponses(assistants, existing);
    const history = new Set([...existing].map(node => node.textContent));
    return assistants.filter(node => !history.has(node.textContent));
  }

  protected responseElement(assistant: Element): Element {
    const clone = assistant.cloneNode(true) as Element;
    for (const pre of clone.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      if (code) pre.replaceChildren(code);
    }
    return clone;
  }

  private composerCircles(scope: Element): Element[] {
    const textarea = scope.querySelector('textarea[placeholder*="DeepSeek"], textarea#chat-input, textarea');
    for (let region = textarea?.parentElement; region && scope.contains(region); region = region.parentElement) {
      const circles = [...region.querySelectorAll('.ds-button--primary.ds-button--circle')].filter(isChatElementVisible);
      if (circles.length) return circles;
      if (region === scope) break;
    }
    return [];
  }

  protected isSnapshotComplete(scope: Element): boolean {
    const circles = this.composerCircles(scope);
    return super.isSnapshotComplete(scope) && (circles.length === 0 || (circles.length === 1 && circles[0]!.matches(sendArrow)));
  }
  protected readonly allowsKeyboardSubmit = true;
  protected readonly sendControlWaitMs = 1_000;

  protected isComposerReady(scope: Element, send: HTMLElement): boolean {
    const circles = this.composerCircles(scope);
    if (circles.length) {
      // The empty composer returns to a disabled send arrow after generation.
      // Wait for that arrow to return; don't require typing another message.
      return circles.length === 1 && circles[0]!.matches(sendArrow);
    }
    return super.isComposerReady(scope, send);
  }

  constructor(document: Document = window.document) { super(document, deepSeekPageSelectors); }
}
