import { TOOL_BRIDGE_REMINDER } from '../../utils/tool-bridge-prompt';
import type { ImageAttachment } from '../../types/attachments';
import { uploadImages } from './image-upload';
import { AdapterError, type ResponseAnchor, type SiteAdapter } from './base';

const MAX_DELTA_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DELTA_THROTTLE_MS = 100;
const STABLE_COMPLETE_MS = 1_500;
const SNAPSHOT_POLL_MS = 250;
const encoder = new TextEncoder();

export const deepSeekSelectors = {
  composerRegion: ['main form', '[data-testid="chat-input"]'],
  composer: ['textarea', '[contenteditable="true"][role="textbox"]'],
  send: ['button[aria-label="发送"]', 'button[aria-label="Send"]', '[data-testid="send-button"]'],
  assistantList: ['main', '[data-testid="conversation-turns"]'],
  assistant: ['[data-message-author-role="assistant"]', '.ds-markdown'],
  stop: ['button[aria-label="停止"]', 'button[aria-label="Stop"]'],
} as const;
export type ChatSelectors = { composerRegion: readonly string[]; composer: readonly string[]; send: readonly string[]; assistantList: readonly string[]; assistant: readonly string[]; stop: readonly string[] };

type AnchorMetadata = {
  assistantList: Element;
  assistantSelector: string;
  chatScope: Element;
  send: HTMLElement;
  preWatchObserver: MutationObserver;
  preWatchCandidates: Set<Element>;
  preWatchAbort: () => void;
  preWatchSignal: AbortSignal;
};

const domChanged = (detail = '页面控件与适配器预期不一致。'): AdapterError => new AdapterError(
  'ADAPTER_DOM_CHANGED',
  detail,
);

const aborted = (): AdapterError => new AdapterError('CONTENT_ABORTED', 'The page request was aborted.');

const isElement = (value: Node): value is Element => value.nodeType === Node.ELEMENT_NODE;

const isVisible = (element: Element): boolean => {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if ((current as HTMLElement).hidden || current.getAttribute('aria-hidden') === 'true') return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style && (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || Number.parseFloat(style.opacity || '1') <= 0
    )) return false;
  }
  return element.getClientRects().length > 0;
};

const isEnabled = (element: Element): element is HTMLElement =>
  element instanceof HTMLElement
  && !element.matches(':disabled')
  && !element.classList.contains('ds-button--disabled')
  && element.getAttribute('aria-disabled') !== 'true';

const outermostAssistants = (assistantList: Element, candidates: Iterable<Element>, assistantSelector: string): Element[] =>
  [...new Set(candidates)].filter((candidate) => {
    const parent = candidate.parentElement?.closest(assistantSelector);
    return !parent || !assistantList.contains(parent);
  });

const addAssistantCandidates = (node: Node, candidates: Set<Element>, assistantSelector: string): void => {
  const addWithAncestors = (element: Element): void => {
    let assistant: Element | null = element.matches(assistantSelector)
      ? element
      : element.closest(assistantSelector);
    while (assistant) {
      candidates.add(assistant);
      assistant = assistant.parentElement?.closest(assistantSelector) ?? null;
    }
  };
  if (!isElement(node)) {
    if (node.parentElement) addWithAncestors(node.parentElement);
    return;
  }
  addWithAncestors(node);
  for (const assistant of node.querySelectorAll(assistantSelector)) addWithAncestors(assistant);
};

const selectOne = (root: ParentNode, selectors: readonly string[], predicate: (element: Element) => boolean, stage = '页面控件'): Element => {
  const candidates = new Set<Element>();
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      if (predicate(element)) candidates.add(element);
    }
  }
  if (candidates.size !== 1) throw domChanged(`${stage}：匹配到 ${candidates.size} 个可用控件，需要唯一一个。`);
  return [...candidates][0]!;
};

const selectPreferred = (root: ParentNode, selectors: readonly string[], predicate: (element: Element) => boolean, stage = '页面控件'): Element => {
  for (const selector of selectors) {
    const candidates = [...root.querySelectorAll(selector)].filter(predicate);
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) throw domChanged(`${stage}：选择器 ${selector} 匹配到 ${candidates.length} 个控件，无法确定目标。`);
  }
  throw domChanged(`${stage}：未找到可见且可用的节点（${selectors.join(', ')}）。`);
};

const commonAncestor = (left: Element, right: Element): Element => {
  for (let candidate: Element | null = left; candidate; candidate = candidate.parentElement) {
    if (candidate.contains(right)) return candidate;
  }
  throw domChanged('发送前 · 输入区与回复区不在同一棵文档树中。');
};

const setNativeValue = (element: HTMLTextAreaElement | HTMLInputElement, value: string): void => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  if (!descriptor?.set) throw domChanged('发送前 · 输入框没有可用的原生 value setter。');
  descriptor.set.call(element, value);
};

const dispatchComposerEvents = (element: HTMLElement, data: string): void => {
  const input = typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, data, inputType: 'insertText' })
    : new Event('input', { bubbles: true });
  element.dispatchEvent(input);
  element.dispatchEvent(new Event('change', { bubbles: true }));
};

const splitUtf8 = (text: string, maximumBytes: number): string[] => {
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of text) {
    const characterBytes = encoder.encode(character).byteLength;
    if (current && currentBytes + characterBytes > maximumBytes) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    // A Unicode scalar is at most four UTF-8 bytes, so it always fits the configured cap.
    current += character;
    currentBytes += characterBytes;
  }
  if (current) parts.push(current);
  return parts;
};

const truncateUtf8 = (text: string, maximumBytes: number): string => {
  if (maximumBytes <= 0) return '';
  let result = '';
  let used = 0;
  for (const character of text) {
    const bytes = encoder.encode(character).byteLength;
    if (used + bytes > maximumBytes) break;
    result += character;
    used += bytes;
  }
  return result;
};

const readBoundedText = (element: Element, maximumBytes: number, structured = false): { text: string; exceeded: boolean } => {
  let text = '';
  let bytes = 0;
  let exceeded = false;
  const append = (value: string): void => {
    const length = encoder.encode(value).byteLength;
    if (bytes + length <= maximumBytes) { text += value; bytes += length; return; }
    for (const character of value) {
      const size = encoder.encode(character).byteLength;
      if (bytes + size > maximumBytes) { exceeded = true; return; }
      text += character; bytes += size;
    }
  };
  const visit = (node: Node): void => {
    if (exceeded) return;
    if (node.nodeType === 3) { append(node.nodeValue ?? ''); return; }
    if (!(node instanceof Element)) return;
    if (structured && node.matches('button, [role="button"], script, style, [hidden], [aria-hidden="true"]')) return;
    const block = structured && node !== element && /^(P|DIV|LI|UL|OL|H[1-6]|PRE|BLOCKQUOTE|TR)$/.test(node.tagName);
    if (structured && node.tagName === 'BR') { append('\n'); return; }
    if (block && text && !text.endsWith('\n')) append('\n');
    if (structured && node.tagName === 'LI') append('• ');
    for (const child of node.childNodes) visit(child);
    if (block && text && !text.endsWith('\n')) append('\n');
  };
  visit(element);
  if (structured) text = text.trimEnd();
  if (exceeded) return { text, exceeded: true };
  return { text, exceeded: false };
};

export class DeepSeekAdapter implements SiteAdapter {
  readonly allowsSameOriginNavigation?: boolean;
  protected readonly finalSnapshotOnly: boolean = false;
  protected readonly preferredComposer: boolean = false;
  protected isSnapshotComplete(scope: Element, _assistant?: Element): boolean { return this.findVisibleStop(scope) === null; }
  protected readonly allowsKeyboardSubmit: boolean = false;
  protected readonly sendControlWaitMs: number = 0;
  private readonly anchorMetadata = new WeakMap<ResponseAnchor, AnchorMetadata>();

  constructor(private readonly document: Document = window.document, private readonly selectors: ChatSelectors = deepSeekSelectors) {}

  protected isComposerReady(scope: Element, send: HTMLElement): boolean {
    return isVisible(send) && isEnabled(send);
  }

  protected responseRoot(): Element {
    return selectPreferred(this.document, this.selectors.assistantList, isVisible, '回复观察区域');
  }
  protected checkResponseError(_scope: Element): void {}
  protected responseElement(assistant: Element): Element { return assistant; }
  protected newResponses(assistants: Element[], existing: ReadonlySet<Element>): Element[] {
    return assistants.slice(existing.size);
  }
  protected selectResponse(candidates: Element[]): Element | undefined {
    if (candidates.length > 1) throw domChanged(`读取回复 · 发现 ${candidates.length} 个新回复节点，无法确定当前轮。节点类型：${candidates.map(node => node.tagName.toLowerCase()).join(', ')}。`);
    return candidates[0];
  }

  protected preparePrompt(prompt: string, scope: Element): string {
    const goalAt = prompt.indexOf('## User goal\n');
    if (!prompt.startsWith('You are kcode, a careful workspace agent.') || goalAt < 0) return prompt;
    const prefix = prompt.slice(0, goalAt);
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    // Check actual user history, not a tab-wide flag: new/cleared conversations
    // must receive the contract, even when their URL or tab ID is unchanged.
    const users = scope.querySelectorAll('[data-message-author-role="user"], [data-role="user"], .user-message-content');
    const alreadyPresent = [...users].some(node => normalize(node.textContent ?? '').startsWith(normalize(prefix)));
    // Translate the internal boundary into a visible separator in the chat.
    const goal = prompt.slice(goalAt + '## User goal\n'.length);
    return (alreadyPresent ? TOOL_BRIDGE_REMINDER : prefix.trimEnd()) + '\n\n---\n\n## 用户任务\n\n' + goal;
  }

  protected writeEditable(composer: HTMLElement, prompt: string): void { composer.textContent = prompt; }

  async sendPrompt(prompt: string, signal: AbortSignal, images?: ImageAttachment[]): Promise<ResponseAnchor> {
    if (signal.aborted) throw aborted();
    const region = selectPreferred(this.document, this.selectors.composerRegion, isVisible, '发送前 · 输入区域');
    const composer = (this.preferredComposer ? selectPreferred : selectOne)(region, this.selectors.composer, (element) => isVisible(element) && isEnabled(element), '发送前 · 输入框');
    if (!(composer instanceof HTMLElement)) throw domChanged('发送前 · 输入框不是 HTML 元素。');
    const assistantList = this.responseRoot();
    const chatScope = commonAncestor(region, assistantList);
    prompt = this.preparePrompt(prompt, chatScope);
    const assistantCandidates = new Set<Element>();
    for (const selector of this.selectors.assistant) {
      for (const assistant of assistantList.querySelectorAll(selector)) assistantCandidates.add(assistant);
    }
    const assistantSelector = this.selectors.assistant.join(',');
    const existingAssistantNodes = new Set<Element>(outermostAssistants(assistantList, assistantCandidates, assistantSelector));

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      setNativeValue(composer, prompt);
    } else if (composer instanceof HTMLElement && composer.getAttribute('contenteditable') === 'true') {
      this.writeEditable(composer, prompt);
    } else {
      throw domChanged('发送前 · 输入框不是 textarea、input 或 contenteditable。');
    }
    dispatchComposerEvents(composer, prompt);
    if (images?.length) await uploadImages(this.document, chatScope, composer, images, signal, () => {
      const sends = new Set(this.selectors.send.flatMap(selector => [...region.querySelectorAll(selector)].filter(isVisible)));
      return sends.size === 0 ? this.allowsKeyboardSubmit : sends.size === 1 && [...sends].every(isEnabled);
    });
    if (signal.aborted) throw aborted();
    // Some DeepSeek layouts expose only an unlabelled icon for Send. Use the
    // composer's Enter contract rather than guessing among unrelated icons.
    await Promise.resolve();
    if (signal.aborted) throw aborted();
    const controlsDeadline = Date.now() + this.sendControlWaitMs;
    while (Date.now() < controlsDeadline) {
      const controls = new Set(this.selectors.send.flatMap(selector =>
        [...region.querySelectorAll(selector)].filter(isVisible)));
      if (controls.size > 1 || (controls.size === 0 && this.allowsKeyboardSubmit) || (controls.size === 1 && [...controls].some(isEnabled))) break;
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => { clearTimeout(timer); reject(aborted()); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 50);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      if (signal.aborted) throw aborted();
    }
    const visibleSendControls = new Set(this.selectors.send.flatMap(selector =>
      [...region.querySelectorAll(selector)].filter(isVisible)));
    const keyboardSubmit = this.allowsKeyboardSubmit && visibleSendControls.size === 0;
    const send = keyboardSubmit ? composer
      : selectOne(region, this.selectors.send, (element) => isVisible(element) && isEnabled(element), `发送前 · 发送按钮（可见 ${visibleSendControls.size} 个；${[...visibleSendControls].filter(isEnabled).length} 个可用，其余被禁用）`);
    if (!(send instanceof HTMLElement)) throw domChanged('发送前 · 发送控件不是 HTML 元素。');
    const anchor: ResponseAnchor = { existingAssistantNodes, startedAt: Date.now() };
    const preWatchCandidates = new Set<Element>();
    const preWatchObserver = new MutationObserver((records) => {
      for (const record of records) {
        addAssistantCandidates(record.target, preWatchCandidates, assistantSelector);
        for (const node of record.addedNodes) addAssistantCandidates(node, preWatchCandidates, assistantSelector);
      }
    });
    const preWatchAbort = (): void => preWatchObserver.disconnect();
    preWatchObserver.observe(assistantList, { childList: true, characterData: true, subtree: true });
    signal.addEventListener('abort', preWatchAbort, { once: true });
    const metadata: AnchorMetadata = {
      assistantList,
      assistantSelector,
      chatScope,
      send,
      preWatchObserver,
      preWatchCandidates,
      preWatchAbort,
      preWatchSignal: signal,
    };
    this.anchorMetadata.set(anchor, metadata);
    try {
      if (keyboardSubmit) {
        composer.focus();
        const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        composer.dispatchEvent(new KeyboardEvent('keydown', options));
        composer.dispatchEvent(new KeyboardEvent('keyup', options));
      } else send.click();
    } catch {
      this.releasePreWatch(anchor, metadata);
      throw domChanged('发送时 · 点击发送按钮或触发键盘提交失败。');
    }
    if (signal.aborted) {
      this.releasePreWatch(anchor, metadata);
      throw aborted();
    }
    return anchor;
  }

  watchResponse(anchor: ResponseAnchor, signal: AbortSignal, emitDelta: (delta: string) => void): Promise<void> {
    const metadata = this.anchorMetadata.get(anchor);
    if (!metadata) return Promise.reject(domChanged('读取回复 · 当前发送请求的观察状态已失效。'));
    this.anchorMetadata.delete(anchor);
    if (signal.aborted) {
      this.releasePreWatch(anchor, metadata);
      return Promise.reject(aborted());
    }
    let initialStop: HTMLElement | null;
    try {
      initialStop = this.findVisibleStop(metadata.chatScope);
    } catch (error) {
      this.releasePreWatch(anchor, metadata);
      return Promise.reject(error instanceof AdapterError ? error : domChanged(`读取回复 · DOM 操作异常（${error instanceof Error ? error.name : 'UnknownError'}）。`));
    }

    return new Promise<void>((resolve, reject) => {
      let closed = false;
      let stopWasVisible = initialStop !== null;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let stableTimer: ReturnType<typeof setTimeout> | undefined;
      let snapshotPoll: ReturnType<typeof setInterval> | undefined;
      let lastSnapshotChange = 0;
      let pending = '';
      let responseBytes = 0;
      let pinnedAssistant: Element | undefined;
      let responseSnapshot = '';
      // Qwen replaces its answer subtree during streaming. Retain its newest
      // snapshot and release it only after the provider signals completion.
      const releaseFinalSnapshotOnly = this.finalSnapshotOnly;

      const cleanup = (): void => {
        observer.disconnect();
        if (snapshotPoll !== undefined) clearInterval(snapshotPoll);
        metadata.preWatchObserver.disconnect();
        metadata.preWatchSignal.removeEventListener('abort', metadata.preWatchAbort);
        signal.removeEventListener('abort', onAbort);
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        if (stableTimer !== undefined) clearTimeout(stableTimer);
      };
      const finish = (error?: AdapterError): void => {
        if (closed) return;
        if (!error) {
          if (releaseFinalSnapshotOnly && responseSnapshot) append(responseSnapshot);
          flush();
        }
        closed = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const flush = (): void => {
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
        if (closed || !pending) return;
        const output = pending;
        pending = '';
        for (const part of splitUtf8(output, MAX_DELTA_BYTES)) emitDelta(part);
      };
      const scheduleFlush = (): void => {
        if (flushTimer === undefined) flushTimer = setTimeout(flush, DELTA_THROTTLE_MS);
      };
      const completeIfStable = (): void => {
        stableTimer = undefined;
        if (closed) return;
        try {
          if (releaseFinalSnapshotOnly) {
            reconcileSnapshot();
            if (!pinnedAssistant?.isConnected || Date.now() - lastSnapshotChange < STABLE_COMPLETE_MS) { scheduleStableCompletion(); return; }
          }
          if (!pinnedAssistant || !responseSnapshot) return;
          // Qwen recreates the composer/send button after routing a new guest
          // conversation, so its saved `send` reference is stale. Its visible
          // stop control remains the authoritative completion signal.
          const ready = releaseFinalSnapshotOnly
            ? this.isSnapshotComplete(metadata.chatScope, pinnedAssistant)
            : this.isComposerReady(metadata.chatScope, metadata.send) && this.findVisibleStop(metadata.chatScope) === null;
          if (ready) {
            flush();
            finish();
          } else scheduleStableCompletion();
        } catch (error) {
          finish(error instanceof AdapterError ? error : domChanged(`读取回复 · DOM 操作异常（${error instanceof Error ? error.name : 'UnknownError'}）。`));
        }
      };
      const scheduleStableCompletion = (): void => {
        if (stableTimer !== undefined) clearTimeout(stableTimer);
        stableTimer = setTimeout(completeIfStable, STABLE_COMPLETE_MS);
      };
      const append = (text: string): void => {
        if (!text || closed) return;
        const remaining = MAX_RESPONSE_BYTES - responseBytes;
        if (remaining <= 0) {
          flush();
          finish(new AdapterError('CONTENT_RESPONSE_LIMIT', 'DeepSeek response exceeded the 512 KiB limit.'));
          return;
        }
        const accepted = truncateUtf8(text, remaining);
        if (accepted) {
          pending += accepted;
          responseBytes += encoder.encode(accepted).byteLength;
          scheduleFlush();
        }
        if (accepted.length !== text.length) {
          flush();
          finish(new AdapterError('CONTENT_RESPONSE_LIMIT', 'DeepSeek response exceeded the 512 KiB limit.'));
        }
      };
      const readAssistant = (assistant: Element): void => {
        if (!metadata.assistantList.contains(assistant) || anchor.existingAssistantNodes.has(assistant)) return;
        if (pinnedAssistant && pinnedAssistant !== assistant) {
          if (!releaseFinalSnapshotOnly && metadata.assistantList.contains(pinnedAssistant)) throw domChanged('读取回复 · 流式输出中出现了不同的回复节点。');
          pinnedAssistant = assistant;
        } else {
          pinnedAssistant = assistant;
        }
        const next = readBoundedText(this.responseElement(assistant), MAX_RESPONSE_BYTES, releaseFinalSnapshotOnly);
        if (next.exceeded) {
          if (next.text.startsWith(responseSnapshot)) {
            append(next.text.slice(responseSnapshot.length));
            flush();
          }
          throw new AdapterError('CONTENT_RESPONSE_LIMIT', 'DeepSeek response exceeded the 512 KiB limit.');
        }
        if (releaseFinalSnapshotOnly) {
          if (responseSnapshot === next.text) return;
          responseSnapshot = next.text;
          lastSnapshotChange = Date.now();
          scheduleStableCompletion();
          return;
        }
        if (responseSnapshot === next.text) return;
        if (!next.text.startsWith(responseSnapshot)) throw domChanged('读取回复 · 网页重写了已读取的流式文本，无法作为增量继续拼接。');
        append(next.text.slice(responseSnapshot.length));
        responseSnapshot = next.text;
        scheduleStableCompletion();
      };
      const collectAssistants = (node: Node): void => {
        const candidates = new Set<Element>();
        addAssistantCandidates(node, candidates, metadata.assistantSelector);
        for (const assistant of outermostAssistants(metadata.assistantList, candidates, metadata.assistantSelector)) readAssistant(assistant);
      };
      // Same-document routing can replace the entire observed subtree. Poll
      // current Qwen DOM as well as observing mutations; a detached observer
      // cannot discover its replacement. Keep the pre-send turn count so cloned
      // history is never released as the answer to this request.
      const reconcileSnapshot = (): void => {
        this.checkResponseError(this.responseRoot());
        if (!metadata.assistantList.isConnected || !metadata.chatScope.isConnected) {
          metadata.assistantList = this.responseRoot();
          const region = selectPreferred(this.document, this.selectors.composerRegion, isVisible, '发送前 · 输入区域');
          metadata.chatScope = commonAncestor(region, metadata.assistantList);
        }
        const assistants = outermostAssistants(metadata.assistantList,
          metadata.assistantList.querySelectorAll(metadata.assistantSelector), metadata.assistantSelector);
        const current = this.newResponses(assistants, anchor.existingAssistantNodes);
        const response = this.selectResponse(current);
        if (response) readAssistant(response);
        else {
          pinnedAssistant = undefined;
          responseSnapshot = '';
        }
      };
      const onAbort = (): void => finish(aborted());
      const observer = new MutationObserver((records) => {
        if (closed) return;
        try {
          if (releaseFinalSnapshotOnly) {
            reconcileSnapshot();
            return;
          }
          for (const record of records) {
            collectAssistants(record.target);
            for (const node of record.addedNodes) collectAssistants(node);
          }
          const stop = this.findVisibleStop(metadata.chatScope);
          if (stop) stopWasVisible = true;
          else if (stopWasVisible) {
            if (!responseSnapshot) return;
            flush();
            finish();
            return;
          }
        } catch (error) {
          finish(error instanceof AdapterError ? error : domChanged(`读取回复 · DOM 操作异常（${error instanceof Error ? error.name : 'UnknownError'}）。`));
        }
      });
      const attributeFilter = ['class', 'style', 'hidden', 'aria-hidden', 'aria-label', 'disabled', 'aria-disabled'];
      observer.observe(metadata.assistantList, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter });
      if (metadata.assistantList !== metadata.chatScope) {
        observer.observe(metadata.chatScope, { childList: true, subtree: true, attributes: true, attributeFilter });
      }
      try {
        for (const record of metadata.preWatchObserver.takeRecords()) {
          addAssistantCandidates(record.target, metadata.preWatchCandidates, metadata.assistantSelector);
          for (const node of record.addedNodes) addAssistantCandidates(node, metadata.preWatchCandidates, metadata.assistantSelector);
        }
        metadata.preWatchObserver.disconnect();
        metadata.preWatchSignal.removeEventListener('abort', metadata.preWatchAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        if (releaseFinalSnapshotOnly) {
          reconcileSnapshot();
          snapshotPoll = setInterval(() => {
            if (closed) return;
            try { reconcileSnapshot(); if (stableTimer === undefined && responseSnapshot) scheduleStableCompletion(); }
            catch (error) { finish(error instanceof AdapterError ? error : domChanged(`读取回复 · DOM 操作异常（${error instanceof Error ? error.name : 'UnknownError'}）。`)); }
          }, SNAPSHOT_POLL_MS);
        } else {
          for (const assistant of outermostAssistants(metadata.assistantList, metadata.preWatchCandidates, metadata.assistantSelector)) readAssistant(assistant);
        }
      } catch (error) {
        finish(error instanceof AdapterError ? error : domChanged(`读取回复 · DOM 操作异常（${error instanceof Error ? error.name : 'UnknownError'}）。`));
      }
    });
  }

  private findVisibleStop(scope: Element): HTMLElement | null {
    const stops = new Set<HTMLElement>();
    for (const selector of this.selectors.stop) {
      for (const element of scope.querySelectorAll(selector)) {
        if (isVisible(element) && isEnabled(element)) stops.add(element);
      }
    }
    if (stops.size > 1) throw domChanged(`判断结束 · 匹配到 ${stops.size} 个可见停止按钮，无法确定生成状态。`);
    return [...stops][0] ?? null;
  }

  private releasePreWatch(anchor: ResponseAnchor, metadata: AnchorMetadata): void {
    metadata.preWatchObserver.disconnect();
    metadata.preWatchSignal.removeEventListener('abort', metadata.preWatchAbort);
    this.anchorMetadata.delete(anchor);
  }
}

export { AdapterError } from './base';
export { isVisible as isChatElementVisible };
