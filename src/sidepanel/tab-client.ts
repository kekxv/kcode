import { isImageAttachments, type ImageAttachment } from '../types/attachments';
import {
  createRequestId,
  isRoutedContentEvent,
  isSidePanelEvent,
  type RoutedContentEvent,
  type ChatProvider,
} from '../types/protocol';

export type ConnectedTab = { id: number; title: string; provider: ChatProvider };
export type PromptHandlers = {
  images?: ImageAttachment[];
  onDelta?: (delta: string) => void;
  onDone?: () => void;
  signal?: AbortSignal;
};

type Pending =
  | { kind: 'list'; resolve: (tabs: ConnectedTab[]) => void; reject: (error: Error) => void }
  | { kind: 'prompt'; handlers: PromptHandlers; resolve: () => void; reject: (error: Error) => void; cleanup: () => void };
type PortFactory = () => chrome.runtime.Port;
const error = (code: string): Error => new Error(code);

/** Side Panel client for the authenticated background Port; it never queries Chrome tabs directly. */
export class TabClient {
  private port: chrome.runtime.Port;
  private disconnected = false;
  private disposed = false;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly connect: PortFactory = () => chrome.runtime.connect({ name: 'kcode-sidepanel' }),
    private readonly queryOnce: ((message: unknown) => Promise<unknown>) | undefined = typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function' ? message => chrome.runtime.sendMessage(message) : undefined) {
    this.port = this.openPort();
  }

  private openPort(): chrome.runtime.Port {
    const port = this.connect();
    this.disconnected = false;
    port.onMessage.addListener(message => { if (this.port === port) this.handle(message); });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.disconnected = true;
      this.rejectAll('TAB_PORT_DISCONNECTED');
    });
    return port;
  }

  private ensurePort(): void {
    if (this.disposed) throw error('TAB_CLIENT_DISPOSED');
    if (this.disconnected) this.port = this.openPort();
  }

  async listConnectedTabs(): Promise<ConnectedTab[]> {
    this.ensurePort();
    if (this.queryOnce) {
      const requestId = createRequestId();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          this.queryOnce({ protocolVersion: 1, kind: 'SIDE_PANEL_LIST_CONNECTED_TABS', requestId }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error('TAB_DISCOVERY_TIMEOUT')), 5000); }),
        ]);
        if (!isSidePanelEvent(response) || response.requestId !== requestId) throw error('TAB_DISCOVERY_INVALID');
        return response.tabs.map(tab => ({ id: tab.tabId, title: tab.title, provider: tab.provider }));
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    return this.send('SIDE_PANEL_LIST_CONNECTED_TABS', undefined, (resolve, reject) => ({ kind: 'list', resolve, reject }));
  }

  sendPrompt(tabId: number, prompt: string, handlers: PromptHandlers = {}): Promise<void> {
    try { this.ensurePort(); } catch (cause) { return Promise.reject(cause); }
    if (handlers.images?.length && !isImageAttachments(handlers.images)) return Promise.reject(error('IMAGE_ATTACHMENT_INVALID'));
    const requestId = createRequestId();
    if (handlers.signal?.aborted) return Promise.reject(error(String(handlers.signal.reason || 'USER_CANCELLED')));
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.pending.get(requestId);
        if (!pending || pending.kind !== 'prompt') return;
        this.pending.delete(requestId);
        pending.cleanup();
        try { this.port.postMessage({ protocolVersion: 1, kind: 'CONTENT_ABORT_REQUEST', requestId, targetTabId: tabId }); } catch { /* Local rejection is authoritative. */ }
        reject(error(String(handlers.signal?.reason || 'USER_CANCELLED')));
      };
      const cleanup = (): void => handlers.signal?.removeEventListener('abort', abort);
      this.pending.set(requestId, { kind: 'prompt', handlers, resolve, reject, cleanup });
      handlers.signal?.addEventListener('abort', abort, { once: true });
      try {
        this.port.postMessage({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId, targetTabId: tabId, prompt, ...(handlers.images?.length ? { images: handlers.images } : {}) });
      } catch {
        this.pending.delete(requestId);
        cleanup();
        reject(error('TAB_PORT_DISCONNECTED'));
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAll('TAB_CLIENT_DISPOSED');
    this.port.disconnect();
  }

  private send<T>(
    kind: 'SIDE_PANEL_LIST_CONNECTED_TABS' | 'CONTENT_SEND_PROMPT',
    payload: { targetTabId: number; prompt: string } | undefined,
    createPending: (resolve: (value: T) => void, reject: (error: Error) => void) => Pending,
  ): Promise<T> {
    const requestId = createRequestId();
    if (this.pending.has(requestId)) return Promise.reject(error('TAB_DUPLICATE_REQUEST_ID'));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, createPending(resolve, reject));
      try {
        this.port.postMessage(kind === 'CONTENT_SEND_PROMPT'
          ? { protocolVersion: 1, kind, requestId, ...payload! }
          : { protocolVersion: 1, kind, requestId });
      } catch {
        this.pending.delete(requestId);
        reject(error('TAB_PORT_DISCONNECTED'));
      }
    });
  }

  private handle(message: unknown): void {
    if (isSidePanelEvent(message)) {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.kind !== 'list') return;
      this.pending.delete(message.requestId);
      pending.resolve(message.tabs.map((tab) => ({ id: tab.tabId, title: tab.title, provider: tab.provider })));
      return;
    }
    if (!isRoutedContentEvent(message)) return;
    this.handlePrompt(message);
  }

  private handlePrompt(event: RoutedContentEvent): void {
    const pending = this.pending.get(event.requestId);
    if (!pending || pending.kind !== 'prompt') return;
    if (event.kind === 'CONTENT_RESPONSE_DELTA') {
      pending.handlers.onDelta?.(event.delta);
      return;
    }
    this.pending.delete(event.requestId);
    pending.cleanup();
    if (event.kind === 'CONTENT_RESPONSE_DONE') {
      pending.handlers.onDone?.();
      pending.resolve();
    } else {
      pending.reject(Object.assign(error(event.code), { detail: event.message }));
    }
  }

  private rejectAll(code: string): void {
    for (const [, pending] of this.pending) {
      if (pending.kind === 'prompt') pending.cleanup();
      pending.reject(error(code));
    }
    this.pending.clear();
  }
}
