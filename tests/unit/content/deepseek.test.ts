// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../fixtures/deepseek.html?raw';
import {
  AdapterError,
  DeepSeekAdapter,
  deepSeekSelectors,
} from '../../../src/content/adapters/deepseek';
import { ContentController } from '../../../src/content/index';

const MAX_DELTA_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

const nextMutation = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const setVisible = (element: Element, visible = true): void => {
  Object.defineProperty(element, 'getClientRects', {
    configurable: true,
    value: () => visible ? [{ width: 1, height: 1 }] : [],
  });
};

const makeAssistant = (text = ''): HTMLElement => {
  const assistant = document.createElement('article');
  assistant.dataset.messageAuthorRole = 'assistant';
  assistant.textContent = text;
  return assistant;
};

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

type FakePort = {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
  receive: (message: unknown) => void;
  disconnect: () => void;
};

const makePort = (): FakePort => {
  let messageListener: ((message: unknown) => void) | undefined;
  let disconnectListener: (() => void) | undefined;
  return {
    name: 'kcode-content',
    postMessage: vi.fn(),
    onMessage: { addListener: (listener) => { messageListener = listener; } },
    onDisconnect: { addListener: (listener) => { disconnectListener = listener; } },
    receive: (message) => messageListener?.(message),
    disconnect: () => disconnectListener?.(),
  };
};

describe('DeepSeekAdapter', () => {
  beforeEach(() => {
    document.body.innerHTML = fixture;
    for (const element of document.querySelectorAll('main, form, textarea, button, [contenteditable], section')) setVisible(element);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends a textarea prompt through native input/change events and snapshots prior assistants', async () => {
    // Break caught: assigning a textarea without input/change leaves the DeepSeek composer state stale.
    const textarea = document.querySelector('textarea')!;
    const send = document.querySelector('button')!;
    const existing = makeAssistant('earlier answer');
    document.querySelector('[data-testid="conversation-turns"]')!.append(existing);
    let dispatchedInput: Event | undefined;
    const change = vi.fn();
    const click = vi.fn();
    textarea.addEventListener('input', (event) => { dispatchedInput = event; });
    textarea.addEventListener('change', change);
    send.addEventListener('click', click);

    const anchor = await new DeepSeekAdapter(document).sendPrompt('请在 /work 中列出文件', new AbortController().signal);

    expect(textarea.value).toBe('请在 /work 中列出文件');
    expect(dispatchedInput).toBeInstanceOf(InputEvent);
    expect((dispatchedInput as InputEvent).data).toBe('请在 /work 中列出文件');
    expect(change).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(anchor.existingAssistantNodes.has(existing)).toBe(true);
  });

  it('writes a contenteditable composer with bubbling input and change events', async () => {
    // Break caught: treating contenteditable like a textarea means no prompt reaches a current DeepSeek composer.
    document.querySelector('textarea')!.remove();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('role', 'textbox');
    setVisible(editor);
    document.querySelector('form')!.prepend(editor);
    const input = vi.fn();
    const change = vi.fn();
    editor.addEventListener('input', input);
    editor.addEventListener('change', change);

    await new DeepSeekAdapter(document).sendPrompt('hello', new AbortController().signal);

    expect(editor.textContent).toBe('hello');
    expect(input).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledOnce();
  });

  it('fails closed when scoped visible composer or send controls are ambiguous', async () => {
    // Break caught: choosing an arbitrary matching button can send a prompt to the wrong conversation action.
    const extraSend = document.createElement('button');
    extraSend.setAttribute('aria-label', '发送');
    setVisible(extraSend);
    document.querySelector('form')!.append(extraSend);

    await expect(new DeepSeekAdapter(document).sendPrompt('hello', new AbortController().signal))
      .rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
  });

  it('ignores hidden matching elements rather than treating them as available controls', async () => {
    // Break caught: a hidden template send button makes a valid visible composer unusable.
    const hiddenSend = document.createElement('button');
    hiddenSend.setAttribute('aria-label', '发送');
    setVisible(hiddenSend, false);
    document.querySelector('form')!.append(hiddenSend);

    await expect(new DeepSeekAdapter(document).sendPrompt('hello', new AbortController().signal)).resolves.toBeDefined();
  });

  it('rejects a composer hidden by computed CSS visibility', async () => {
    // Break caught: layout rectangles alone misclassify `visibility:hidden` controls as safe to click.
    document.querySelector('textarea')!.style.visibility = 'hidden';

    await expect(new DeepSeekAdapter(document).sendPrompt('hello', new AbortController().signal))
      .rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
  });

  it('rejects otherwise-visible controls inside an opacity-zero ancestor', async () => {
    // Break caught: opacity is not inherited, so checking only the control's computed style exposes a transparent template composer.
    const form = document.querySelector('form')!;
    const wrapper = document.createElement('div');
    wrapper.style.opacity = '0';
    wrapper.append(document.querySelector('textarea')!, document.querySelector('button')!);
    form.append(wrapper);

    await expect(new DeepSeekAdapter(document).sendPrompt('hello', new AbortController().signal))
      .rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
  });

  it('rejects a disabled scoped composer instead of sending through an unavailable control', async () => {
    // Break caught: writing into a disabled textarea looks successful locally but never reaches the site application.
    document.querySelector('textarea')!.setAttribute('disabled', '');

    await expect(new DeepSeekAdapter(document).sendPrompt('hello', new AbortController().signal))
      .rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
  });

  it('emits only newly-created assistant text as non-duplicated incremental deltas', async () => {
    // Break caught: observing the full conversation leaks prior replies and repeats whole response snapshots.
    vi.useFakeTimers();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, new AbortController().signal, (delta) => deltas.push(delta));
    const list = document.querySelector('[data-testid="conversation-turns"]')!;
    const assistant = makeAssistant('hel');
    list.append(assistant);
    await nextMutation();
    assistant.textContent = 'hello';
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', '停止');
    setVisible(stop);
    document.querySelector('main')!.append(stop);
    await nextMutation();
    stop.remove();
    await nextMutation();

    await expect(watch).resolves.toBeUndefined();
    expect(deltas.join('')).toBe('hello');
  });

  it('processes the final assistant mutation before stop-disappearance completion', async () => {
    // Break caught: same-turn final text and stop removal otherwise completes before the final MutationRecord is read.
    vi.useFakeTimers();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, new AbortController().signal, (delta) => deltas.push(delta));
    const assistant = makeAssistant('start');
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', '停止');
    setVisible(stop);
    document.querySelector('[data-testid="conversation-turns"]')!.append(assistant);
    document.querySelector('main')!.append(stop);
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();

    assistant.textContent = 'start-final';
    stop.remove();
    await nextMutation();

    await watch;
    expect(deltas.join('')).toBe('start-final');
  });

  it('captures an assistant response inserted synchronously by the send click before watchResponse starts', async () => {
    // Break caught: a response rendered in the send handler lands between click and observer setup, so the first reply delta is lost.
    vi.useFakeTimers();
    const send = document.querySelector('button')!;
    send.addEventListener('click', () => {
      document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('immediate'));
    });
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const abort = new AbortController();
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, abort.signal, (delta) => deltas.push(delta));
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();

    expect(deltas.join('')).toBe('immediate');
    abort.abort();
    await expect(watch).rejects.toMatchObject({ code: 'CONTENT_ABORTED' } satisfies Partial<AdapterError>);
  });

  it('does not emit a response delta before the 100 ms throttle window', async () => {
    // Break caught: immediate per-mutation Port events bypass the required batching bound.
    vi.useFakeTimers();
    const abort = new AbortController();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', abort.signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, abort.signal, (delta) => deltas.push(delta));
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('batched'));
    await nextMutation();

    vi.advanceTimersByTime(99);
    expect(deltas).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(deltas).toEqual(['batched']);
    abort.abort();
    await expect(watch).rejects.toMatchObject({ code: 'CONTENT_ABORTED' } satisfies Partial<AdapterError>);
  });

  it('deduplicates multiple MutationRecords that expose the same final snapshot', async () => {
    // Break caught: record-by-record full snapshots repeat already emitted response text.
    vi.useFakeTimers();
    const abort = new AbortController();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', abort.signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, abort.signal, (delta) => deltas.push(delta));
    const assistant = makeAssistant('a');
    const list = document.querySelector('[data-testid="conversation-turns"]')!;
    list.append(assistant);
    assistant.append('b');
    assistant.append('c');
    await nextMutation();
    vi.advanceTimersByTime(100);

    expect(deltas.join('')).toBe('abc');
    abort.abort();
    await expect(watch).rejects.toMatchObject({ code: 'CONTENT_ABORTED' } satisfies Partial<AdapterError>);
  });

  it('splits response changes so no event exceeds 32 KiB', async () => {
    // Break caught: forwarding a large streamed DOM update violates the runtime Port delta cap.
    vi.useFakeTimers();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, new AbortController().signal, (delta) => deltas.push(delta));
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('a'.repeat(MAX_DELTA_BYTES + 12)));
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', '停止');
    setVisible(stop);
    document.querySelector('main')!.append(stop);
    await nextMutation();
    stop.remove();
    await nextMutation();

    await watch;
    expect(deltas).not.toHaveLength(0);
    expect(deltas.every((delta) => byteLength(delta) <= MAX_DELTA_BYTES)).toBe(true);
    expect(deltas.join('')).toHaveLength(MAX_DELTA_BYTES + 12);
  });

  it('does not duplicate text when a new role wrapper contains a matching markdown child', async () => {
    // Break caught: nested assistant selectors can emit the same streamed text once for the wrapper and again for its markdown child.
    vi.useFakeTimers();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, new AbortController().signal, (delta) => deltas.push(delta));
    const assistant = makeAssistant();
    const markdown = document.createElement('div');
    markdown.className = 'ds-markdown';
    markdown.textContent = 'nested';
    assistant.append(markdown);
    document.querySelector('[data-testid="conversation-turns"]')!.append(assistant);
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', '停止');
    setVisible(stop);
    document.querySelector('main')!.append(stop);
    await nextMutation();
    stop.remove();
    await nextMutation();

    await watch;
    expect(deltas.join('')).toBe('nested');
  });

  it('resolves nested markdown CharacterData mutations to the pinned outer assistant', async () => {
    // Break caught: closest-inner selector filtering drops direct text-node mutations under nested `.ds-markdown`.
    vi.useFakeTimers();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, new AbortController().signal, (delta) => deltas.push(delta));
    const assistant = makeAssistant();
    const markdown = document.createElement('div');
    markdown.className = 'ds-markdown';
    markdown.append('a');
    assistant.append(markdown);
    document.querySelector('[data-testid="conversation-turns"]')!.append(assistant);
    await nextMutation();
    markdown.firstChild!.nodeValue = 'ab';
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();
    vi.advanceTimersByTime(1_500);

    await watch;
    expect(deltas.join('')).toBe('ab');
  });

  it('continues an append-only reply across root replacement without replaying accumulated text', async () => {
    // Break caught: per-element snapshots emit the full accumulated response again when a framework replaces its wrapper.
    vi.useFakeTimers();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, new AbortController().signal, (delta) => deltas.push(delta));
    const first = makeAssistant('hello');
    document.querySelector('[data-testid="conversation-turns"]')!.append(first);
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();

    const replacement = makeAssistant('hello world');
    first.replaceWith(replacement);
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();
    vi.advanceTimersByTime(1_500);

    await watch;
    expect(deltas.join('')).toBe('hello world');
  });

  it('fails closed instead of mixing two newly-created assistant roots', async () => {
    // Break caught: concatenating multiple post-click assistants destroys request-to-response identity.
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const watch = adapter.watchResponse(anchor, new AbortController().signal, () => undefined);
    const list = document.querySelector('[data-testid="conversation-turns"]')!;
    list.append(makeAssistant('first'), makeAssistant('second'));
    await nextMutation();

    await expect(watch).rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
  });

  it('fails closed when stop controls become ambiguous during a streamed response', async () => {
    // Break caught: an exception thrown inside a MutationObserver leaves the request live instead of reporting a DOM contract change.
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const watch = adapter.watchResponse(anchor, new AbortController().signal, () => undefined);
    const main = document.querySelector('main')!;
    for (const label of ['停止', 'Stop']) {
      const stop = document.createElement('button');
      stop.setAttribute('aria-label', label);
      setVisible(stop);
      main.append(stop);
    }
    await nextMutation();

    await expect(watch).rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
  });

  it('ignores an unrelated stop control outside the selected chat scope', async () => {
    // Break caught: document-wide stop lookup lets unrelated page controls stall or terminate this response.
    vi.useFakeTimers();
    const unrelated = document.createElement('button');
    unrelated.setAttribute('aria-label', 'Stop');
    setVisible(unrelated);
    document.body.append(unrelated);
    const adapter = new DeepSeekAdapter(document);
    const abort = new AbortController();
    const anchor = await adapter.sendPrompt('hello', abort.signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, abort.signal, (delta) => deltas.push(delta));
    let settled = false;
    void watch.then(() => { settled = true; });
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('scoped'));
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();
    vi.advanceTimersByTime(1_500);
    await nextMutation();

    expect(settled).toBe(true);
    expect(deltas.join('')).toBe('scoped');
    if (!settled) {
      abort.abort();
      await expect(watch).rejects.toMatchObject({ code: 'CONTENT_ABORTED' } satisfies Partial<AdapterError>);
    }
  });

  it('disconnects the pre-watch observer when stop ambiguity exists before watchResponse', async () => {
    // Break caught: an early Promise-executor throw leaves the pre-click observer retaining the conversation subtree.
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    for (const label of ['停止', 'Stop']) {
      const stop = document.createElement('button');
      stop.setAttribute('aria-label', label);
      setVisible(stop);
      document.querySelector('main')!.append(stop);
    }

    await expect(adapter.watchResponse(anchor, new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
    expect(disconnect).toHaveBeenCalled();
  });

  it('cleans both observers when buffered pre-watch candidates are ambiguous', async () => {
    // Break caught: adoption throws inside the Promise executor after the main observer starts, leaking that observer and timers.
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const send = document.querySelector('button')!;
    send.addEventListener('click', () => {
      document.querySelector('[data-testid="conversation-turns"]')!
        .append(makeAssistant('first'), makeAssistant('second'));
    });
    const adapter = new DeepSeekAdapter(document);
    const signal = new AbortController().signal;
    const anchor = await adapter.sendPrompt('hello', signal);

    await expect(adapter.watchResponse(anchor, signal, () => undefined))
      .rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
    expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('disconnects the pre-watch observer when the send click throws', async () => {
    // Break caught: an exceptional click path otherwise leaves the pre-click observer and abort listener registered.
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    Object.defineProperty(document.querySelector('button')!, 'click', {
      configurable: true,
      value: () => { throw new Error('click failed'); },
    });
    const adapter = new DeepSeekAdapter(document);

    await expect(adapter.sendPrompt('hello', new AbortController().signal))
      .rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('aborts at the 512 KiB response cap instead of emitting unbounded text', async () => {
    // Break caught: an endlessly growing response can consume extension memory and Port bandwidth without a limit.
    vi.useFakeTimers();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, new AbortController().signal, (delta) => deltas.push(delta));
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('x'.repeat(MAX_RESPONSE_BYTES + 1)));
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();

    await expect(watch).rejects.toMatchObject({ code: 'CONTENT_RESPONSE_LIMIT' } satisfies Partial<AdapterError>);
    expect(byteLength(deltas.join(''))).toBe(MAX_RESPONSE_BYTES);
  });

  it('bounds a large non-prefix DOM rewrite before retaining or classifying it', async () => {
    // Break caught: storing an unbounded rewritten textContent bypasses accounting even when no append-only delta can represent it.
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const watch = adapter.watchResponse(anchor, new AbortController().signal, () => undefined);
    const assistant = makeAssistant('a');
    document.querySelector('[data-testid="conversation-turns"]')!.append(assistant);
    await nextMutation();
    assistant.textContent = `b${'界'.repeat(Math.ceil(MAX_RESPONSE_BYTES / 3))}`;
    await nextMutation();

    await expect(watch).rejects.toMatchObject({ code: 'CONTENT_RESPONSE_LIMIT' } satisfies Partial<AdapterError>);
  });

  it('accounts for the 512 KiB response boundary in UTF-8 bytes', async () => {
    // Break caught: counting UTF-16 code units lets multibyte text exceed the response byte cap.
    vi.useFakeTimers();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, new AbortController().signal, (delta) => deltas.push(delta));
    const exact = `${'界'.repeat(174_762)}ab`;
    const assistant = makeAssistant(exact);
    document.querySelector('[data-testid="conversation-turns"]')!.append(assistant);
    await nextMutation();
    vi.advanceTimersByTime(100);
    expect(byteLength(deltas.join(''))).toBe(MAX_RESPONSE_BYTES);
    assistant.append('界');
    await nextMutation();

    await expect(watch).rejects.toMatchObject({ code: 'CONTENT_RESPONSE_LIMIT' } satisfies Partial<AdapterError>);
  });

  it('fails closed when a required scoped selector is missing', async () => {
    // Break caught: silently continuing without the selected send control can mutate the composer without sending the prompt.
    document.querySelector('button[aria-label="发送"]')!.remove();

    await expect(new DeepSeekAdapter(document).sendPrompt('hello', new AbortController().signal))
      .rejects.toMatchObject({ code: 'ADAPTER_DOM_CHANGED' } satisfies Partial<AdapterError>);
  });

  it('completes after stable text for 1.5 seconds when scoped send is enabled', async () => {
    // Break caught: waiting forever for a stop control that the site never renders leaves a request stuck.
    vi.useFakeTimers();
    const adapter = new DeepSeekAdapter(document);
    const anchor = await adapter.sendPrompt('hello', new AbortController().signal);
    const deltas: string[] = [];
    const watch = adapter.watchResponse(anchor, new AbortController().signal, (delta) => deltas.push(delta));
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('finished'));
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();
    vi.advanceTimersByTime(1500);
    await expect(watch).resolves.toBeUndefined();
    expect(deltas.join('')).toBe('finished');
  });

  it('exports selectors from one explicit adapter boundary', () => {
    // Break caught: scattered unreviewed selectors can silently broaden DOM access beyond the composer scope.
    expect(deepSeekSelectors.composerRegion).toContain('main form');
    expect(deepSeekSelectors.send).toContain('button[aria-label="发送"]');
  });
});

describe('ContentController', () => {
  beforeEach(() => {
    document.body.innerHTML = fixture;
    for (const element of document.querySelectorAll('main, form, textarea, button, [contenteditable], section')) setVisible(element);
  });

  afterEach(() => vi.useRealTimers());

  it('rejects a concurrent prompt with CONTENT_BUSY and finishes only the original request', async () => {
    // Break caught: concurrent prompt runs attach multiple observers and mix responses across request IDs.
    vi.useFakeTimers();
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'first', prompt: 'one' });
    await nextMutation();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'second', prompt: 'two' });

    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'second', code: 'CONTENT_BUSY' }));
    const list = document.querySelector('[data-testid="conversation-turns"]')!;
    list.append(makeAssistant('one'));
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', '停止');
    setVisible(stop);
    document.querySelector('main')!.append(stop);
    await nextMutation();
    stop.remove();
    await nextMutation();

    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'first', kind: 'CONTENT_RESPONSE_DONE' }));
  });

  it('silently suppresses an active duplicate request ID so it receives one terminal event', async () => {
    // Break caught: replying CONTENT_BUSY to a replayed active ID contradicts its later DONE event.
    vi.useFakeTimers();
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    const command = { protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'same', prompt: 'one' } as const;
    port.receive(command);
    await nextMutation();
    port.receive(command);
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('one'));
    await nextMutation();
    vi.advanceTimersByTime(1_500);
    await nextMutation();

    const terminal = port.postMessage.mock.calls.filter(([event]) => {
      const value = event as { requestId?: string; kind?: string };
      return value.requestId === 'same' && (value.kind === 'CONTENT_ERROR' || value.kind === 'CONTENT_RESPONSE_DONE');
    });
    expect(terminal).toHaveLength(1);
    expect(terminal[0]![0]).toMatchObject({ kind: 'CONTENT_RESPONSE_DONE' });
  });

  it('does not resubmit a completed request ID', async () => {
    // Break caught: replaying a completed authenticated command submits the prompt a second time and can emit another terminal result.
    vi.useFakeTimers();
    const clicks = vi.fn();
    document.querySelector('button')!.addEventListener('click', clicks);
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    const command = { protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'completed', prompt: 'one' } as const;
    port.receive(command);
    await nextMutation();
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('one'));
    await nextMutation();
    vi.advanceTimersByTime(1_500);
    await nextMutation();
    port.receive(command);
    await nextMutation();

    expect(clicks).toHaveBeenCalledOnce();
    const terminal = port.postMessage.mock.calls.filter(([event]) => {
      const value = event as { requestId?: string; kind?: string };
      return value.requestId === 'completed' && (value.kind === 'CONTENT_ERROR' || value.kind === 'CONTENT_RESPONSE_DONE');
    });
    expect(terminal).toHaveLength(1);
  });

  it('aborts the active prompt on navigation and reports one terminal error', async () => {
    // Break caught: a navigation leaves an observer operating against a replaced page.
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'nav', prompt: 'one' });
    await nextMutation();
    window.dispatchEvent(new Event('pagehide'));
    await nextMutation();

    const terminal = port.postMessage.mock.calls.filter(([event]) =>
      (event as { requestId?: string }).requestId === 'nav' && (event as { kind?: string }).kind === 'CONTENT_ERROR',
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]![0]).toMatchObject({ code: 'CONTENT_ABORTED' });
  });

  it('aborts on same-document SPA navigation before late DOM can complete the old request', async () => {
    // Break caught: DeepSeek conversation changes through History API do not emit pagehide/beforeunload.
    vi.useFakeTimers();
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'spa', prompt: 'one' });
    await nextMutation();
    window.history.pushState({}, '', '#different-conversation');
    await nextMutation();
    expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 'spa', code: 'CONTENT_ABORTED' }));
    vi.advanceTimersByTime(250);
    await nextMutation();
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('late'));
    await nextMutation();

    const events = port.postMessage.mock.calls.map(([event]) => event as { requestId?: string; kind?: string; code?: string });
    expect(events).toContainEqual(expect.objectContaining({ requestId: 'spa', kind: 'CONTENT_ERROR', code: 'CONTENT_ABORTED' }));
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: 'spa', kind: 'CONTENT_RESPONSE_DONE' }));
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: 'spa', kind: 'CONTENT_RESPONSE_DELTA' }));
    controller.dispose();
  });

  it('blocks a delta produced before the SPA poll after pushState changes the request URL', async () => {
    // Break caught: a new conversation can emit at the 100 ms delta timer before the 250 ms URL poll runs.
    vi.useFakeTimers();
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'push-race', prompt: 'one' });
    await nextMutation();
    window.history.pushState({}, '', '#push-race');
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('must-not-leak'));
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();

    const events = port.postMessage.mock.calls.map(([event]) => event as { requestId?: string; kind?: string; code?: string });
    expect(events).toContainEqual(expect.objectContaining({ requestId: 'push-race', kind: 'CONTENT_ERROR', code: 'CONTENT_ABORTED' }));
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: 'push-race', kind: 'CONTENT_RESPONSE_DELTA' }));
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: 'push-race', kind: 'CONTENT_RESPONSE_DONE' }));
    controller.dispose();
  });

  it('blocks DONE before the SPA poll after replaceState changes the request URL', async () => {
    // Break caught: stop-disappearance can resolve the adapter and release DONE before the 250 ms URL poll.
    vi.useFakeTimers();
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'replace-race', prompt: 'one' });
    await nextMutation();
    const assistant = makeAssistant('already-safe');
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', '停止');
    setVisible(stop);
    document.querySelector('[data-testid="conversation-turns"]')!.append(assistant);
    document.querySelector('main')!.append(stop);
    await nextMutation();
    vi.advanceTimersByTime(100);
    await nextMutation();
    port.postMessage.mockClear();

    window.history.replaceState({}, '', '#replace-race');
    stop.remove();
    await nextMutation();

    const events = port.postMessage.mock.calls.map(([event]) => event as { requestId?: string; kind?: string; code?: string });
    expect(events).toContainEqual(expect.objectContaining({ requestId: 'replace-race', kind: 'CONTENT_ERROR', code: 'CONTENT_ABORTED' }));
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: 'replace-race', kind: 'CONTENT_RESPONSE_DONE' }));
    controller.dispose();
  });

  it('reports navigation instead of a stale adapter error before the SPA poll', async () => {
    // Break caught: a post-navigation DOM failure can release the wrong terminal classification before URL polling.
    vi.useFakeTimers();
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'error-race', prompt: 'one' });
    await nextMutation();
    window.history.pushState({}, '', '#error-race');
    for (const label of ['停止', 'Stop']) {
      const stop = document.createElement('button');
      stop.setAttribute('aria-label', label);
      setVisible(stop);
      document.querySelector('main')!.append(stop);
    }
    await nextMutation();

    const events = port.postMessage.mock.calls.map(([event]) => event as { requestId?: string; kind?: string; code?: string });
    expect(events).toContainEqual(expect.objectContaining({ requestId: 'error-race', kind: 'CONTENT_ERROR', code: 'CONTENT_ABORTED' }));
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: 'error-race', code: 'ADAPTER_DOM_CHANGED' }));
    controller.dispose();
  });

  it('aborts immediately on an authenticated router-session replacement command', async () => {
    // Break caught: replacing the owning router/side-panel session leaves the old DOM observer able to complete a stale request.
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'replaced', prompt: 'one' });
    await nextMutation();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_ABORT_REQUEST', requestId: 'replaced' });
    await nextMutation();
    document.querySelector('[data-testid="conversation-turns"]')!.append(makeAssistant('late'));
    await nextMutation();

    const events = port.postMessage.mock.calls.map(([event]) => event as { requestId?: string; kind?: string; code?: string });
    expect(events).toContainEqual(expect.objectContaining({ requestId: 'replaced', kind: 'CONTENT_ERROR', code: 'CONTENT_SESSION_REPLACED' }));
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: 'replaced', kind: 'CONTENT_RESPONSE_DONE' }));
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: 'replaced', kind: 'CONTENT_RESPONSE_DELTA' }));
  });

  it('times out a stalled prompt after 90 seconds', async () => {
    // Break caught: a missing DeepSeek completion leaves an authenticated router request live indefinitely.
    vi.useFakeTimers();
    const port = makePort();
    const controller = new ContentController(port as never, new DeepSeekAdapter(document), window);
    controller.start();
    port.receive({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'slow', prompt: 'one' });
    await nextMutation();
    vi.advanceTimersByTime(90_000);
    await nextMutation();

    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'slow', kind: 'CONTENT_ERROR', code: 'CONTENT_TIMEOUT' }));
  });
});
