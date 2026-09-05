import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTrustedChatSender, isTrustedSidePanelSender, PortRouter } from '../../src/background/port-router';

const extensionId = 'trusted-extension';
const panelUrl = `chrome-extension://${extensionId}/src/sidepanel/index.html`;

const sender = (overrides: Record<string, unknown> = {}) => ({
  id: extensionId,
  frameId: 0,
  origin: 'https://chat.deepseek.com',
  url: 'https://chat.deepseek.com/',
  tab: { id: 17 },
  ...overrides,
});

const makePort = (name: string, portSender: Record<string, unknown>) => ({
  name,
  sender: portSender,
  postMessage: vi.fn(),
  onMessage: { addListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() },
});

afterEach(() => vi.unstubAllGlobals());

describe('extension message authentication', () => {
  it('accepts only this extension side panel and a top-frame sender from an exact supported chat origin', () => {
    vi.stubGlobal('chrome', { runtime: { id: extensionId, getURL: vi.fn().mockReturnValue(panelUrl) } });
    expect(isTrustedSidePanelSender(sender({ url: panelUrl }) as chrome.runtime.MessageSender)).toBe(true);
    expect(isTrustedSidePanelSender(sender({ url: `${panelUrl}?lookalike` }) as chrome.runtime.MessageSender)).toBe(false);
    for (const origin of ['https://chat.deepseek.com', 'https://chat.qwen.ai', 'https://aistudio.google.com', 'https://chatgpt.com']) {
      expect(isTrustedChatSender(sender({ origin, url: `${origin}/` }) as chrome.runtime.MessageSender)).toBe(true);
    }

    for (const invalid of [
      sender({ id: 'foreign-extension' }),
      sender({ origin: 'https://evil.example', url: 'https://evil.example/' }),
      sender({ frameId: 1 }),
      sender({ url: 'https://chat.qwen.ai.evil.example/' }),
    ]) {
      expect(isTrustedChatSender(invalid as chrome.runtime.MessageSender)).toBe(false);
    }
  });

  it('rejects unauthenticated ports and rechecks a content tab before forwarding', async () => {
    const connect = { addListener: vi.fn() };
    const chromeStub = {
      runtime: { id: extensionId, getURL: vi.fn().mockReturnValue(panelUrl), onConnect: connect },
      tabs: { get: vi.fn().mockResolvedValue({ id: 17, url: 'https://evil.example/' }) },
    };
    vi.stubGlobal('chrome', chromeStub);
    const router = new PortRouter();
    router.register();
    const acceptPort = connect.addListener.mock.calls[0][0] as (port: chrome.runtime.Port) => void;
    const panel = makePort('kcode-sidepanel', sender({ url: panelUrl }));
    const rejectedPorts = [
      makePort('kcode-content', sender({ id: 'foreign-extension' })),
      makePort('kcode-content', sender({ origin: 'https://evil.example', url: 'https://evil.example/' })),
      makePort('kcode-content', sender({ frameId: 1 })),
      makePort('kcode-sidepanel', sender({ url: `${panelUrl}?lookalike` })),
    ];
    const staleContent = makePort('kcode-content', sender());
    acceptPort(panel as never);
    for (const rejected of rejectedPorts) acceptPort(rejected as never);
    acceptPort(staleContent as never);

    await router.fromSidePanel({
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-1', targetTabId: 17, prompt: 'hello',
    });

    for (const rejected of rejectedPorts) {
      expect(rejected.onMessage.addListener).not.toHaveBeenCalled();
      expect(rejected.postMessage).not.toHaveBeenCalled();
    }
    expect(staleContent.postMessage).not.toHaveBeenCalled();
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ code: 'TAB_IDENTITY_LOST' }));
  });

  it('restricts local and session storage before background startup uses extension state', async () => {
    const calls: string[] = [];
    vi.stubGlobal('chrome', {
      sidePanel: { setPanelBehavior: vi.fn() },
      storage: {
        local: { setAccessLevel: vi.fn(() => { calls.push('local'); }) },
        session: { setAccessLevel: vi.fn(() => { calls.push('session'); }) },
      },
      runtime: { onConnect: { addListener: vi.fn() }, id: extensionId, getURL: vi.fn().mockReturnValue(panelUrl) },
    });
    await import('../../src/background/index');
    expect(calls).toEqual(['local', 'session']);
  });
});
