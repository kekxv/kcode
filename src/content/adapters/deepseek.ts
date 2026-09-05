import { AdapterError, type ResponseAnchor, type SiteAdapter } from './base';

const MAX_DELTA_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DELTA_THROTTLE_MS = 100;
const STABLE_COMPLETE_MS = 1_500;
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

const domChanged = (): AdapterError => new AdapterError(
  'ADAPTER_DOM_CHANGED',
  'DeepSeek page controls no longer match the scoped adapter contract.',
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

const selectOne = (root: ParentNode, selectors: readonly string[], predicate: (element: Element) => boolean): Element => {
  const candidates = new Set<Element>();
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      if (predicate(element)) candidates.add(element);
    }
  }
  if (candidates.size !== 1) throw domChanged();
  return [...candidates][0]!;
};

const selectPreferred = (root: ParentNode, selectors: readonly string[], predicate: (element: Element) => boolean): Element => {
  for (const selector of selectors) {
    const candidates = [...root.querySelectorAll(selector)].filter(predicate);
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) throw domChanged();
  }
  throw domChanged();
};

const commonAncestor = (left: Element, right: Element): Element => {
  for (let candidate: Element | null = left; candidate; candidate = candidate.parentElement) {
    if (candidate.contains(right)) return candidate;
  }
  throw domChanged();
};

const setNativeValue = (element: HTMLTextAreaElement | HTMLInputElement, value: string): void => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  if (!descriptor?.set) throw domChanged();
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

const readBoundedText = (element: Element, maximumBytes: number): { text: string; exceeded: boolean } => {
  const showText = element.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = element.ownerDocument.createTreeWalker(element, showText);
  let text = '';
  let bytes = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const character of node.nodeValue ?? '') {
      const characterBytes = encoder.encode(character).byteLength;
      if (bytes + characterBytes > maximumBytes) return { text, exceeded: true };
      text += character;
      bytes += characterBytes;
    }
  }
  return { text, exceeded: false };
};

export class DeepSeekAdapter implements SiteAdapter {
  private readonly anchorMetadata = new WeakMap<ResponseAnchor, AnchorMetadata>();

  constructor(private readonly document: Document = window.document, private readonly selectors: ChatSelectors = deepSeekSelectors) {}

  async sendPrompt(prompt: string, signal: AbortSignal): Promise<ResponseAnchor> {
    if (signal.aborted) throw aborted();
    const region = selectPreferred(this.document, this.selectors.composerRegion, isVisible);
    const composer = selectOne(region, this.selectors.composer, (element) => isVisible(element) && isEnabled(element));
    const send = selectOne(region, this.selectors.send, (element) => isVisible(element) && isEnabled(element));
    if (!(composer instanceof HTMLElement) || !(send instanceof HTMLElement)) throw domChanged();
    const assistantList = selectPreferred(this.document, this.selectors.assistantList, isVisible);
    const chatScope = commonAncestor(region, assistantList);
    const assistantCandidates = new Set<Element>();
    for (const selector of this.selectors.assistant) {
      for (const assistant of assistantList.querySelectorAll(selector)) assistantCandidates.add(assistant);
    }
    const assistantSelector = this.selectors.assistant.join(',');
    const existingAssistantNodes = new Set<Element>(outermostAssistants(assistantList, assistantCandidates, assistantSelector));

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      setNativeValue(composer, prompt);
    } else if (composer instanceof HTMLElement && composer.getAttribute('contenteditable') === 'true') {
      composer.textContent = prompt;
    } else {
      throw domChanged();
    }
    dispatchComposerEvents(composer, prompt);
    if (signal.aborted) throw aborted();
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
      send.click();
    } catch {
      this.releasePreWatch(anchor, metadata);
      throw domChanged();
    }
    if (signal.aborted) {
      this.releasePreWatch(anchor, metadata);
      throw aborted();
    }
    return anchor;
  }

  watchResponse(anchor: ResponseAnchor, signal: AbortSignal, emitDelta: (delta: string) => void): Promise<void> {
    const metadata = this.anchorMetadata.get(anchor);
    if (!metadata) return Promise.reject(domChanged());
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
      return Promise.reject(error instanceof AdapterError ? error : domChanged());
    }

    return new Promise<void>((resolve, reject) => {
      let closed = false;
      let stopWasVisible = initialStop !== null;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let stableTimer: ReturnType<typeof setTimeout> | undefined;
      let pending = '';
      let responseBytes = 0;
      let pinnedAssistant: Element | undefined;
      let responseSnapshot = '';

      const cleanup = (): void => {
        observer.disconnect();
        metadata.preWatchObserver.disconnect();
        metadata.preWatchSignal.removeEventListener('abort', metadata.preWatchAbort);
        signal.removeEventListener('abort', onAbort);
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        if (stableTimer !== undefined) clearTimeout(stableTimer);
      };
      const finish = (error?: AdapterError): void => {
        if (closed) return;
        closed = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const flush = (): void => {
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
        if (closed || !pinnedAssistant) return;
        try {
          if (isVisible(metadata.send) && isEnabled(metadata.send) && this.findVisibleStop(metadata.chatScope) === null) {
            flush();
            finish();
          }
        } catch (error) {
          finish(error instanceof AdapterError ? error : domChanged());
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
          if (metadata.assistantList.contains(pinnedAssistant)) throw domChanged();
          pinnedAssistant = assistant;
        } else {
          pinnedAssistant = assistant;
        }
        const next = readBoundedText(assistant, MAX_RESPONSE_BYTES);
        if (next.exceeded) {
          if (next.text.startsWith(responseSnapshot)) {
            append(next.text.slice(responseSnapshot.length));
            flush();
          }
          throw new AdapterError('CONTENT_RESPONSE_LIMIT', 'DeepSeek response exceeded the 512 KiB limit.');
        }
        if (!next.text.startsWith(responseSnapshot)) throw domChanged();
        append(next.text.slice(responseSnapshot.length));
        responseSnapshot = next.text;
        scheduleStableCompletion();
      };
      const collectAssistants = (node: Node): void => {
        const candidates = new Set<Element>();
        addAssistantCandidates(node, candidates, metadata.assistantSelector);
        for (const assistant of outermostAssistants(metadata.assistantList, candidates, metadata.assistantSelector)) readAssistant(assistant);
      };
      const onAbort = (): void => finish(aborted());
      const observer = new MutationObserver((records) => {
        if (closed) return;
        try {
          for (const record of records) {
            collectAssistants(record.target);
            for (const node of record.addedNodes) collectAssistants(node);
          }
          const stop = this.findVisibleStop(metadata.chatScope);
          if (stop) stopWasVisible = true;
          else if (stopWasVisible) {
            flush();
            finish();
            return;
          }
        } catch (error) {
          finish(error instanceof AdapterError ? error : domChanged());
        }
      });
      observer.observe(metadata.assistantList, { childList: true, characterData: true, subtree: true });
      if (metadata.assistantList !== metadata.chatScope) {
        observer.observe(metadata.chatScope, { childList: true, subtree: true });
      }
      try {
        for (const record of metadata.preWatchObserver.takeRecords()) {
          addAssistantCandidates(record.target, metadata.preWatchCandidates, metadata.assistantSelector);
          for (const node of record.addedNodes) addAssistantCandidates(node, metadata.preWatchCandidates, metadata.assistantSelector);
        }
        metadata.preWatchObserver.disconnect();
        metadata.preWatchSignal.removeEventListener('abort', metadata.preWatchAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        for (const assistant of outermostAssistants(metadata.assistantList, metadata.preWatchCandidates, metadata.assistantSelector)) readAssistant(assistant);
      } catch (error) {
        finish(error instanceof AdapterError ? error : domChanged());
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
    if (stops.size > 1) throw domChanged();
    return [...stops][0] ?? null;
  }

  private releasePreWatch(anchor: ResponseAnchor, metadata: AnchorMetadata): void {
    metadata.preWatchObserver.disconnect();
    metadata.preWatchSignal.removeEventListener('abort', metadata.preWatchAbort);
    this.anchorMetadata.delete(anchor);
  }
}

export { AdapterError } from './base';
