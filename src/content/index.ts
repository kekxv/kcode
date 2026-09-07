import { isContentCommand, type ContentCommand, type ContentEvent } from '../types/protocol';
import { AdapterError, type SiteAdapter } from './adapters/base';
import { adapterForOrigin } from './adapters/registry';

const CONTENT_PORT = 'kcode-content';
const TERMINAL_ID_LIMIT = 1_024;
const NAVIGATION_POLL_MS = 250;

type ContentPort = Pick<chrome.runtime.Port, 'name' | 'postMessage' | 'onMessage' | 'onDisconnect'>;
type PageWindow = Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'>;

type ActiveRequest = {
  requestId: string;
  startingHref: string;
  controller: AbortController;
  navigationWatch?: ReturnType<typeof setInterval>;
};

const post = (port: ContentPort, event: ContentEvent): boolean => {
  try {
    port.postMessage(event);
    return true;
  } catch {
    // A disconnect has the same effect as an abort. Do not expose page content in diagnostics.
    return false;
  }
};

export class ContentController {
  private active?: ActiveRequest;
  private started = false;
  private readonly terminalIds = new Set<string>();

  constructor(
    private readonly port: ContentPort,
    private readonly adapter: SiteAdapter,
    private readonly pageWindow: PageWindow = window,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.port.onMessage.addListener((message) => this.receive(message));
    this.port.onDisconnect.addListener(() => this.abortActive());
    this.pageWindow.addEventListener('pagehide', this.onNavigation, { once: true });
    this.pageWindow.addEventListener('beforeunload', this.onNavigation, { once: true });
    this.pageWindow.addEventListener('popstate', this.onNavigation);
    this.pageWindow.addEventListener('hashchange', this.onNavigation);
  }

  dispose(): void {
    this.abortActive();
    this.pageWindow.removeEventListener('pagehide', this.onNavigation);
    this.pageWindow.removeEventListener('beforeunload', this.onNavigation);
    this.pageWindow.removeEventListener('popstate', this.onNavigation);
    this.pageWindow.removeEventListener('hashchange', this.onNavigation);
  }

  private readonly onNavigation = (): void => this.abortActive('CONTENT_ABORTED');

  private receive(message: unknown): void {
    if (!isContentCommand(message)) return;
    if (this.active && !this.isCurrentLocation(this.active)) this.abortActive('CONTENT_ABORTED');
    if (message.kind === 'CONTENT_ABORT_REQUEST') {
      if (this.active?.requestId === message.requestId) this.abortActive('CONTENT_SESSION_REPLACED');
      return;
    }
    if (this.terminalIds.has(message.requestId)) return;
    if (this.active) {
      if (this.active.requestId === message.requestId) return;
      this.postError(message.requestId, 'CONTENT_BUSY', 'A chat-page request is already active.');
      return;
    }
    void this.run(message);
  }

  private async run(command: Extract<ContentCommand, { kind: 'CONTENT_SEND_PROMPT' }>): Promise<void> {
    const controller = new AbortController();
    const active: ActiveRequest = {
      requestId: command.requestId,
      startingHref: this.pageWindow.location.href,
      controller,
    };
    active.navigationWatch = setInterval(() => {
      if (this.active === active && !this.isCurrentLocation(active)) this.abortActive('CONTENT_ABORTED');
    }, NAVIGATION_POLL_MS);
    this.active = active;
    try {
      const anchor = await this.adapter.sendPrompt(command.prompt, controller.signal, command.images);
      if (this.active !== active) return;
      await this.adapter.watchResponse(anchor, controller.signal, (delta) => {
        if (this.active !== active) return;
        if (!this.isCurrentLocation(active)) {
          this.abortActive('CONTENT_ABORTED');
          return;
        }
        if (!post(this.port, { protocolVersion: 1, kind: 'CONTENT_RESPONSE_DELTA', requestId: command.requestId, delta })) this.abortActive();
      });
      if (this.active !== active) return;
      if (!this.isCurrentLocation(active)) {
        this.abortActive('CONTENT_ABORTED');
        return;
      }
      this.clearActive(active);
      this.postTerminal({ protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: command.requestId });
    } catch (error) {
      if (this.active !== active) return;
      if (!this.isCurrentLocation(active)) {
        this.abortActive('CONTENT_ABORTED');
        return;
      }
      this.clearActive(active);
      const adapterError = error instanceof AdapterError ? error : undefined;
      this.postError(command.requestId, adapterError?.code ?? 'ADAPTER_DOM_CHANGED', adapterError?.message ?? 'Chat page controls changed.');
    }
  }

  private abortActive(code?: 'CONTENT_ABORTED' | 'CONTENT_SESSION_REPLACED'): void {
    const active = this.active;
    if (!active) return;
    if (code && code !== 'CONTENT_ABORTED' && !this.isCurrentLocation(active)) code = 'CONTENT_ABORTED';
    this.clearActive(active);
    active.controller.abort();
    if (code) {
      const message = code === 'CONTENT_SESSION_REPLACED'
          ? 'The authenticated router session was replaced.'
          : 'The chat page was replaced.';
      this.postError(active.requestId, code, message);
    }
  }

  private clearActive(active: ActiveRequest): void {
    if (this.active !== active) return;
    if (active.navigationWatch !== undefined) clearInterval(active.navigationWatch);
    this.active = undefined;
  }

  private isCurrentLocation(active: ActiveRequest): boolean {
    const currentHref = this.pageWindow.location.href;
    if (currentHref === active.startingHref) return true;
    // Qwen rewrites same-document conversation URLs while it creates and
    // streams a chat. A real document replacement still emits pagehide, and
    // a cross-origin navigation still fails this boundary.
    if (
      this.adapter.allowsSameOriginNavigation
      && new URL(currentHref).origin === new URL(active.startingHref).origin
    ) {
      active.startingHref = currentHref;
      return true;
    }
    return false;
  }

  private postError(requestId: string, code: string, message: string): void {
    this.postTerminal({ protocolVersion: 1, kind: 'CONTENT_ERROR', requestId, code, message });
  }

  private postTerminal(event: Extract<ContentEvent, { kind: 'CONTENT_RESPONSE_DONE' | 'CONTENT_ERROR' }>): void {
    if (this.terminalIds.has(event.requestId)) return;
    this.terminalIds.add(event.requestId);
    if (this.terminalIds.size > TERMINAL_ID_LIMIT) {
      const oldest = this.terminalIds.values().next().value as string | undefined;
      if (oldest !== undefined) this.terminalIds.delete(oldest);
    }
    post(this.port, event);
  }
}

const canBootContentScript = (): boolean =>
  typeof chrome !== 'undefined'
  && typeof window !== 'undefined'
  && typeof chrome.runtime?.connect === 'function'
  && window.top === window;

if (canBootContentScript()) {
  const adapter = adapterForOrigin(window.location.origin, document);
  if (adapter) {
    let stopped = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener('pagehide', () => { stopped = true; if (reconnect) clearTimeout(reconnect); });
    const connect = (): void => {
      if (stopped) return;
      try {
        const port = chrome.runtime.connect({ name: CONTENT_PORT });
        const controller = new ContentController(port, adapter);
        controller.start();
        port.onDisconnect.addListener(() => {
          controller.dispose();
          if (!stopped) reconnect = setTimeout(connect, 1000);
        });
      } catch {
        // An extension reload invalidates this content-script context. A page
        // refresh is required; do not retry or replay an old task.
        stopped = true;
      }
    };
    connect();
  }
}
