import {
  createRequestId,
  isContentEvent,
  isSidePanelCommand,
  type ContentCommand,
  type ContentEvent,
  type RoutedContentEvent,
  type SidePanelCommand,
  type SidePanelEvent,
} from '../types/protocol';

const SIDE_PANEL_PORT = 'kcode-sidepanel';
const CONTENT_PORT = 'kcode-content';
const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';

const safeOrigin = (url: string | undefined): string | null => {
  try {
    return new URL(url ?? '').origin;
  } catch {
    return null;
  }
};

export const isTrustedSidePanelSender = (sender: chrome.runtime.MessageSender): boolean =>
  sender.id === chrome.runtime.id
  && sender.url === chrome.runtime.getURL('src/sidepanel/index.html');

export const isTrustedDeepSeekSender = (sender: chrome.runtime.MessageSender): boolean =>
  sender.id === chrome.runtime.id
  && sender.frameId === 0
  && sender.origin === DEEPSEEK_ORIGIN
  && safeOrigin(sender.url) === DEEPSEEK_ORIGIN;

type RouterDependencies = {
  tabs: Pick<typeof chrome.tabs, 'get'>;
  runtime?: Pick<typeof chrome.runtime, 'onConnect'>;
};

type PendingRequest = {
  sidePanel: chrome.runtime.Port;
  content: chrome.runtime.Port;
  targetTabId: number;
};

const isDeepSeekTab = (tab: chrome.tabs.Tab, targetTabId: number): boolean =>
  tab.id === targetTabId && safeOrigin(tab.url) === DEEPSEEK_ORIGIN;

const isTabId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export class PortRouter {
  private sidePanel?: chrome.runtime.Port;
  private sidePanelSession = createRequestId();
  private readonly contents = new Map<number, chrome.runtime.Port>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly dependencies: RouterDependencies;

  constructor(dependencies?: RouterDependencies) {
    this.dependencies = dependencies ?? { tabs: chrome.tabs, runtime: chrome.runtime };
  }

  register(): void {
    const runtime = this.dependencies.runtime ?? chrome.runtime;
    runtime.onConnect.addListener((port) => this.connect(port));
  }

  /** Used by the authenticated onConnect boundary and integration tests. */
  setSidePanelPort(port: chrome.runtime.Port): void {
    if (this.sidePanel && this.sidePanel !== port) this.failForSidePanel(this.sidePanel);
    this.sidePanel = port;
    this.sidePanelSession = createRequestId();
  }

  /** Used by the authenticated onConnect boundary and integration tests. */
  setContentPort(port: chrome.runtime.Port): void {
    const tabId = port.sender?.tab?.id;
    if (!isTabId(tabId)) return;
    const previous = this.contents.get(tabId);
    if (previous && previous !== port) this.failForContent(previous);
    this.contents.set(tabId, port);
  }

  async fromSidePanel(message: unknown): Promise<void> {
    if (!isSidePanelCommand(message) || !this.sidePanel) return;
    const sidePanel = this.sidePanel;
    if (message.kind === 'SIDE_PANEL_LIST_CONNECTED_TABS') {
      const tabs: SidePanelEvent['tabs'] = [...this.contents.entries()]
        .map(([tabId, port]) => ({ tabId, title: port.sender?.tab?.title ?? 'DeepSeek' }))
        .sort((left, right) => left.tabId - right.tabId);
      this.tryPost(sidePanel, { protocolVersion: 1, kind: 'SIDE_PANEL_CONNECTED_TABS', requestId: message.requestId, tabs });
      return;
    }
    const content = this.contents.get(message.targetTabId);
    if (!content) {
      this.postIdentityLost(sidePanel, message.requestId, message.targetTabId);
      return;
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await this.dependencies.tabs.get(message.targetTabId);
    } catch {
      this.postIdentityLost(sidePanel, message.requestId, message.targetTabId);
      return;
    }
    if (this.sidePanel !== sidePanel || this.contents.get(message.targetTabId) !== content || !isDeepSeekTab(tab, message.targetTabId)) {
      this.postIdentityLost(sidePanel, message.requestId, message.targetTabId);
      return;
    }

    const command: ContentCommand = {
      protocolVersion: 1,
      kind: 'CONTENT_SEND_PROMPT',
      requestId: message.requestId,
      prompt: message.prompt,
    };
    this.pending.set(message.requestId, { sidePanel, content, targetTabId: message.targetTabId });
    if (!this.tryPost(content, command)) {
      this.pending.delete(message.requestId);
      this.postIdentityLost(sidePanel, message.requestId, message.targetTabId);
    }
  }

  async fromContent(port: chrome.runtime.Port, message: unknown): Promise<void> {
    const sourceTabId = port.sender?.tab?.id;
    if (!isTabId(sourceTabId) || this.contents.get(sourceTabId) !== port || !isContentEvent(message)) return;
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.content !== port || pending.targetTabId !== sourceTabId || this.sidePanel !== pending.sidePanel) return;

    let tab: chrome.tabs.Tab;
    try {
      tab = await this.dependencies.tabs.get(sourceTabId);
    } catch {
      if (this.pending.get(message.requestId) === pending) this.failRequest(message.requestId, pending);
      return;
    }
    if (
      !isDeepSeekTab(tab, sourceTabId)
      || this.pending.get(message.requestId) !== pending
      || this.contents.get(sourceTabId) !== port
      || this.sidePanel !== pending.sidePanel
    ) {
      if (this.pending.get(message.requestId) === pending) this.failRequest(message.requestId, pending);
      return;
    }

    const routed: RoutedContentEvent = { ...message, sourceTabId };
    if (message.kind === 'CONTENT_RESPONSE_DELTA') {
      if (!this.tryPost(pending.sidePanel, routed)) this.failRequest(message.requestId, pending);
      return;
    }
    this.pending.delete(message.requestId);
    this.tryPost(pending.sidePanel, routed);
  }

  private connect(port: chrome.runtime.Port): void {
    const sender = port.sender;
    if (port.name === SIDE_PANEL_PORT && sender && isTrustedSidePanelSender(sender)) {
      this.setSidePanelPort(port);
      port.onMessage.addListener((message) => void this.fromSidePanel(message));
      port.onDisconnect.addListener(() => {
        if (this.sidePanel === port) {
          this.failForSidePanel(port);
          this.sidePanel = undefined;
        }
      });
      return;
    }
    if (port.name === CONTENT_PORT && sender && isTrustedDeepSeekSender(sender)) {
      const tabId = sender.tab?.id;
      if (!isTabId(tabId)) return;
      this.setContentPort(port);
      port.onMessage.addListener((message) => void this.fromContent(port, message));
      port.onDisconnect.addListener(() => {
        if (this.contents.get(tabId) === port) {
          this.contents.delete(tabId);
          this.failForContent(port);
        }
      });
    }
  }

  private failForSidePanel(sidePanel: chrome.runtime.Port): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sidePanel === sidePanel) {
        this.failRequest(requestId, pending);
      }
    }
  }

  private failForContent(content: chrome.runtime.Port): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.content === content) {
        this.failRequest(requestId, pending);
      }
    }
  }

  private failRequest(requestId: string, pending: PendingRequest): void {
    if (this.pending.get(requestId) === pending) this.pending.delete(requestId);
    this.postIdentityLost(pending.sidePanel, requestId, pending.targetTabId);
  }

  private postIdentityLost(sidePanel: chrome.runtime.Port, requestId: string, sourceTabId: number): void {
    const event: RoutedContentEvent = {
      protocolVersion: 1,
      kind: 'CONTENT_ERROR',
      requestId,
      code: 'TAB_IDENTITY_LOST',
      message: 'The target tab identity changed before the request could complete.',
      sourceTabId,
    };
    this.tryPost(sidePanel, event);
  }

  private tryPost(port: chrome.runtime.Port, message: ContentCommand | RoutedContentEvent | SidePanelEvent): boolean {
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }
}
