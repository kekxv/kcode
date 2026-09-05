import { isContentCommand, type ContentCommand, type ContentEvent } from '../types/protocol';
import { AdapterError, type SiteAdapter } from './adapters/base';
import { DeepSeekAdapter } from './adapters/deepseek';

const CONTENT_PORT = 'kcode-content';
const REQUEST_TIMEOUT_MS = 90_000;
const TERMINAL_ID_LIMIT = 1_024;
const NAVIGATION_POLL_MS = 250;

type ContentPort = Pick<chrome.runtime.Port, 'name' | 'postMessage' | 'onMessage' | 'onDisconnect'>;
type PageWindow = Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'>;

type ActiveRequest = {
  requestId: string;
  startingHref: string;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
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
      this.postError(message.requestId, 'CONTENT_BUSY', 'A DeepSeek request is already active.');
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
      timeout: setTimeout(() => this.abortActive('CONTENT_TIMEOUT'), REQUEST_TIMEOUT_MS),
    };
    active.navigationWatch = setInterval(() => {
      if (this.active === active && !this.isCurrentLocation(active)) this.abortActive('CONTENT_ABORTED');
    }, NAVIGATION_POLL_MS);
    this.active = active;
    try {
      const anchor = await this.adapter.sendPrompt(command.prompt, controller.signal);
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
      this.postError(command.requestId, adapterError?.code ?? 'ADAPTER_DOM_CHANGED', adapterError?.message ?? 'DeepSeek page controls changed.');
    }
  }

  private abortActive(code?: 'CONTENT_ABORTED' | 'CONTENT_TIMEOUT' | 'CONTENT_SESSION_REPLACED'): void {
    const active = this.active;
    if (!active) return;
    if (code && code !== 'CONTENT_ABORTED' && !this.isCurrentLocation(active)) code = 'CONTENT_ABORTED';
    this.clearActive(active);
    active.controller.abort();
    if (code) {
      const message = code === 'CONTENT_TIMEOUT'
        ? 'The DeepSeek request timed out.'
        : code === 'CONTENT_SESSION_REPLACED'
          ? 'The authenticated router session was replaced.'
          : 'The DeepSeek page was replaced.';
      this.postError(active.requestId, code, message);
    }
  }

  private clearActive(active: ActiveRequest): void {
    if (this.active !== active) return;
    clearTimeout(active.timeout);
    if (active.navigationWatch !== undefined) clearInterval(active.navigationWatch);
    this.active = undefined;
  }

  private isCurrentLocation(active: ActiveRequest): boolean {
    return this.pageWindow.location.href === active.startingHref;
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
  const port = chrome.runtime.connect({ name: CONTENT_PORT });
  new ContentController(port, new DeepSeekAdapter(document)).start();
}
