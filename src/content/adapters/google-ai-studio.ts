import { AdapterError, DeepSeekAdapter, isChatElementVisible, type ChatSelectors } from './deepseek';

export const googleAiStudioSelectors: ChatSelectors = {
  composerRegion: ['.prompt-box-container', 'main form', '[data-google-composer]'],
  composer: ['textarea.cdk-textarea-autosize', 'textarea[data-google-composer]', 'textarea', '[contenteditable="true"][role="textbox"]'],
  // Current AI Studio's Run button has no aria-label; the stable submit class
  // distinguishes it from uploads, API-key selection, tools and dictation.
  send: ['button.ctrl-enter-submits', 'button[data-google-send]', 'button[aria-label="Run"]', 'button[aria-label="Send"]', 'button[aria-label="发送"]'],
  // A new AI Studio conversation need not have a message list (or <main>) yet.
  // Observe the stable document root until model turns are created after Run.
  assistantList: ['body'],
  assistant: ['ms-chat-turn:has(.model-prompt-container)', 'ms-chat-turn:has([data-role="model"])', '.model-prompt-container', '[data-message-author-role="assistant"]', '[data-role="model"]'],
  stop: ['button[aria-label="Stop"]', 'button[aria-label="Stop generating"]', 'button[aria-label="Stop response"]', 'button[aria-label="停止"]'],
};
export class GoogleAiStudioAdapter extends DeepSeekAdapter {
  readonly allowsSameOriginNavigation = true;
  protected readonly preferredComposer = true;
  protected readonly finalSnapshotOnly = true;
  protected readonly sendControlWaitMs = 3_000;
  private sentPrompt = '';
  private previousErrors = new Map<Element, string>();
  private historicalBodies: string[] = [];
  private normalized(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
  protected preparePrompt(prompt: string, scope: Element): string {
    this.previousErrors = new Map([...scope.querySelectorAll('.model-error')].filter(isChatElementVisible).map(node => [node, node.textContent ?? '']));
    this.sentPrompt = super.preparePrompt(prompt, scope);
    const selector = googleAiStudioSelectors.assistant.join(',');
    const nodes = [...scope.querySelectorAll(selector)].filter(node => !node.parentElement?.closest(selector));
    this.historicalBodies = nodes.filter(node => !this.isUserTurn(node)).map(node => this.responseElement(node).textContent ?? '');
    return this.sentPrompt;
  }
  protected checkResponseError(scope: Element): void {
    for (const node of scope.querySelectorAll('.model-error')) {
      if (node.closest('pre, code, ms-cmark-node') || !isChatElementVisible(node)) continue;
      if (this.previousErrors.get(node) === node.textContent) continue;
      const copy = node.cloneNode(true) as Element;
      for (const icon of copy.querySelectorAll('[aria-hidden="true"], .material-symbols-outlined')) icon.remove();
      const message = this.normalized(copy.textContent ?? '');
      if (!message) continue;
      if (/rate limit/i.test(message)) throw new AdapterError('PROVIDER_RATE_LIMITED', 'AI Studio 已达到速率限制，请稍后重试。');
      throw new AdapterError('PROVIDER_ERROR', `AI Studio 返回错误：${message.slice(0, 1200)}`);
    }
  }
  private isUserTurn(node: Element): boolean {
    const turn = node.closest('ms-chat-turn') ?? node;
    if (turn.matches('[data-role="user"], [data-message-author-role="user"]')
      || turn.querySelector('.user-prompt-container, [data-message-author-role="user"], [data-role="user"]')) return true;
    const header = turn.querySelector('.model-prompt-container, .author-label, .turn-role');
    if (header) {
      const label = header.cloneNode(true) as Element;
      for (const body of label.querySelectorAll('ms-cmark-node, pre, code, .markdown, button, ms-thought-chunk')) body.remove();
      if (/^(?:User|You|用户|你)(?:\s|[·•]|$)/i.test(label.textContent?.trim() ?? '')) return true;
    }
    // AI Studio can share its generic turn wrapper with the user prompt. An
    // exact echo of what we submitted is never a model/tool response.
    return !!this.sentPrompt && this.normalized(this.responseElement(turn).textContent ?? '') === this.normalized(this.sentPrompt);
  }
  protected selectResponse(candidates: Element[]): Element | undefined {
    const answers = candidates.filter(node => !this.isUserTurn(node) && this.responseElement(node).textContent?.trim());
    // Thoughts and final output may occupy separate turns; only the latter
    // has answer content. Distinct nonempty answers still require disambiguation.
    return super.selectResponse(answers);
  }
  protected newResponses(assistants: Element[], existing: ReadonlySet<Element>): Element[] {
    // The UI may add hidden copies or remount older turns during syntax
    // highlighting. A node-count offset then mistakes history for this reply.
    assistants = assistants.filter(node => !this.isUserTurn(node));
    const lastExisting = assistants.findLastIndex(node => existing.has(node));
    let start = lastExisting + 1;
    if (lastExisting < 0) {
      // Match a remounted history prefix in order (not a global text set), so
      // a genuinely new answer identical to an old answer is still retained.
      while (start < this.historicalBodies.length && start < assistants.length
        && (this.responseElement(assistants[start]!).textContent ?? '') === this.historicalBodies[start]) start += 1;
    }
    const candidates = assistants.slice(start);
    return candidates.filter(node => {
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        if (parent.matches('[hidden], [aria-hidden="true"]')) return false;
        const style = this.page.defaultView?.getComputedStyle(parent);
        if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      }
      return true;
    });
  }
  /** Read the answer body across the whole turn, never its model header or thoughts card. */
  protected responseElement(assistant: Element): Element {
    const turn = assistant.closest('ms-chat-turn') ?? assistant;
    const copy = turn.cloneNode(true) as Element;
    // AI Studio's Material title contains an image and comments, so it is
    // not a leaf text node. Strip the containing panel, including its retained
    // collapsed content; a sibling final answer must remain untouched.
    for (const title of copy.querySelectorAll('mat-panel-title, .mat-expansion-panel-header-title')) {
      if (title.closest('pre, code')) continue;
      if (!title.querySelector('img[alt="Thinking"]') && title.textContent?.trim() !== 'Thoughts') continue;
      const panel = title.closest('mat-expansion-panel, .mat-expansion-panel');
      if (panel && copy.contains(panel)) panel.remove();
    }
    const thoughts = 'ms-thought-chunk, ms-thoughts, ms-thinking, .thoughts-container, .thought-container, .thoughts-panel, .thought-chunk, [data-type="thought"], [data-role="thought"], [aria-label="Thoughts"]';
    for (const node of copy.querySelectorAll(thoughts)) {
      if (!node.closest('pre, code')) node.remove();
    }
    // Some versions expose the card only through its visible title and toggle.
    // Remove the smallest card enclosing both labels, not the surrounding turn.
    for (const node of copy.querySelectorAll('*')) {
      if (node.closest('pre, code') || node.children.length || node.textContent?.trim() !== 'Thoughts') continue;
      for (let card = node.parentElement; card && card !== copy; card = card.parentElement) {
        if (/Expand to view model thoughts/.test(card.textContent ?? '')) { card.remove(); break; }
      }
    }
    for (const node of copy.querySelectorAll('button, [role="button"], [hidden], [aria-hidden="true"], .code-block-header, .code-header')) node.remove();
    const bodies = [...copy.querySelectorAll('ms-cmark-node, .markdown, .markdown-main-panel, [data-message-content], pre, code')];
    const answer = this.page.createElement('div');
    for (const body of bodies.filter(node => !bodies.some(parent => parent !== node && parent.contains(node)))) answer.append(body.cloneNode(true));
    if (answer.childNodes.length) return answer;
    // Legacy role-annotated plain replies have no Markdown component. A full
    // AI Studio turn/header without a body is still waiting for its answer.
    if (turn.matches('ms-chat-turn, .model-prompt-container') || /(?:^|\n)\s*(?:Model(?:\s|$)|正在思考|Thinking|Thoughts)/i.test(copy.textContent ?? '')) return answer;
    return copy;
  }
  protected isSnapshotComplete(scope: Element, assistant?: Element): boolean {
    if (!assistant || !this.responseElement(assistant).textContent?.trim()) return false;
    const run = scope.querySelector('.prompt-box-container button.ctrl-enter-submits');
    const text = run?.textContent?.trim() ?? '';
    // Run is disabled when the composer is empty, including after a finished
    // response. Only explicit generation signals can keep a stable answer open.
    if (run?.getAttribute('aria-busy') === 'true' || /^(?:stop|停止)(?:\s|$)/i.test(text)) return false;
    return super.isSnapshotComplete(scope, assistant);
  }
  // Observation roots need not have a layout box; empty lists and body can
  // have zero dimensions while the absolutely positioned composer is visible.
  protected responseRoot(): Element { return this.page.body; }
  constructor(private readonly page: Document = window.document) { super(page, googleAiStudioSelectors); }
}
