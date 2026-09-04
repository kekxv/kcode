import {
  createRequestId,
  isRoutedContentEvent,
  isSidePanelEvent,
  type RoutedContentEvent,
} from '../types/protocol';

export type ConnectedTab = { id: number; title: string };
export type PromptHandlers = {
  onDelta?: (delta: string) => void;
  onDone?: () => void;
};

type Pending =
  | { kind: 'list'; resolve: (tabs: ConnectedTab[]) => void; reject: (error: Error) => void }
  | { kind: 'prompt'; handlers: PromptHandlers; resolve: () => void; reject: (error: Error) => void };
type PortFactory = () => chrome.runtime.Port;
const error = (code: string): Error => new Error(code);

/** Side Panel client for the authenticated background Port; it never queries Chrome tabs directly. */
export class TabClient {
  private readonly port: chrome.runtime.Port;
  private readonly pending = new Map<string, Pending>();

  constructor(connect: PortFactory = () => chrome.runtime.connect({ name: 'kcode-sidepanel' })) {
    this.port = connect();
    this.port.onMessage.addListener((message) => this.handle(message));
    this.port.onDisconnect.addListener(() => this.rejectAll('TAB_PORT_DISCONNECTED'));
  }

  listConnectedTabs(): Promise<ConnectedTab[]> {
    return this.send('SIDE_PANEL_LIST_CONNECTED_TABS', undefined, (resolve, reject) => ({ kind: 'list', resolve, reject }));
  }

  sendPrompt(tabId: number, prompt: string, handlers: PromptHandlers = {}): Promise<void> {
    return this.send('CONTENT_SEND_PROMPT', { targetTabId: tabId, prompt }, (resolve, reject) => ({ kind: 'prompt', handlers, resolve, reject }));
  }

  dispose(): void {
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
      pending.resolve(message.tabs.map((tab) => ({ id: tab.tabId, title: tab.title })));
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
    if (event.kind === 'CONTENT_RESPONSE_DONE') {
      pending.handlers.onDone?.();
      pending.resolve();
    } else {
      pending.reject(error(event.code));
    }
  }

  private rejectAll(code: string): void {
    for (const [, pending] of this.pending) pending.reject(error(code));
    this.pending.clear();
  }
}
