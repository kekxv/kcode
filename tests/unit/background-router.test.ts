import { describe, expect, it, vi } from 'vitest';
import { PortRouter } from '../../src/background/port-router';

type Listener<T> = { addListener: (listener: T) => void };

const makePort = (name: string, tabId?: number) => ({
  name,
  sender: tabId === undefined ? {} : { tab: { id: tabId } },
  postMessage: vi.fn(),
  onMessage: { addListener: vi.fn() } as Listener<(message: unknown) => void>,
  onDisconnect: { addListener: vi.fn() } as Listener<() => void>,
});

describe('PortRouter', () => {
  it('routes a content response without embedding callbacks', async () => {
    const sidePanel = makePort('kcode-sidepanel');
    const content17 = makePort('kcode-content', 17);
    const content18 = makePort('kcode-content', 18);
    const router = new PortRouter({
      tabs: { get: vi.fn().mockResolvedValue({ id: 17, url: 'https://chat.deepseek.com/' }) },
    });
    router.setSidePanelPort(sidePanel as never);
    router.setContentPort(content17 as never);
    router.setContentPort(content18 as never);

    const request = {
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-1',
      targetTabId: 17, prompt: 'hello',
    } as const;
    await router.fromSidePanel(request);
    expect(content17.postMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ targetTabId: 17 }),
    );
    expect(content18.postMessage).not.toHaveBeenCalled();
    router.fromContent(content17 as never, {
      protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    });
    expect(sidePanel.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 'req-1', sourceTabId: 17 }),
    );
    router.fromContent(content17 as never, {
      protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-2',
      sourceTabId: 999,
    });
    expect(sidePanel.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-2' }),
    );
  });

  it('fails a pending prompt when the tab identity changes before forwarding', async () => {
    const sidePanel = makePort('kcode-sidepanel');
    const content17 = makePort('kcode-content', 17);
    const router = new PortRouter({
      tabs: { get: vi.fn().mockResolvedValue({ id: 17, url: 'https://example.com/' }) },
    });
    router.setSidePanelPort(sidePanel as never);
    router.setContentPort(content17 as never);

    await router.fromSidePanel({
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-1',
      targetTabId: 17, prompt: 'hello',
    });

    expect(content17.postMessage).not.toHaveBeenCalled();
    expect(sidePanel.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'CONTENT_ERROR', requestId: 'req-1', code: 'TAB_IDENTITY_LOST',
    }));
  });
});
