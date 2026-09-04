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
    await router.fromContent(content17 as never, {
      protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    });
    expect(sidePanel.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 'req-1', sourceTabId: 17 }),
    );
    await router.fromContent(content17 as never, {
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

  it('rechecks the content tab origin before forwarding its response', async () => {
    const sidePanel = makePort('kcode-sidepanel');
    const content17 = makePort('kcode-content', 17);
    const router = new PortRouter({
      tabs: {
        get: vi.fn()
          .mockResolvedValueOnce({ id: 17, url: 'https://chat.deepseek.com/' })
          .mockResolvedValueOnce({ id: 17, url: 'https://example.com/' }),
      },
    });
    router.setSidePanelPort(sidePanel as never);
    router.setContentPort(content17 as never);
    await router.fromSidePanel({
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-1', targetTabId: 17, prompt: 'hello',
    });

    await router.fromContent(content17 as never, {
      protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    });

    expect(sidePanel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    }));
    expect(sidePanel.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'CONTENT_ERROR', requestId: 'req-1', code: 'TAB_IDENTITY_LOST',
    }));
  });

  it('does not forward a response after its active content port is replaced during identity lookup', async () => {
    let resolveResponseLookup!: (tab: { id: number; url: string }) => void;
    const responseLookup = new Promise<{ id: number; url: string }>((resolve) => { resolveResponseLookup = resolve; });
    const sidePanel = makePort('kcode-sidepanel');
    const content17 = makePort('kcode-content', 17);
    const replacement = makePort('kcode-content', 17);
    const router = new PortRouter({
      tabs: {
        get: vi.fn()
          .mockResolvedValueOnce({ id: 17, url: 'https://chat.deepseek.com/' })
          .mockReturnValueOnce(responseLookup),
      },
    });
    router.setSidePanelPort(sidePanel as never);
    router.setContentPort(content17 as never);
    await router.fromSidePanel({
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-1', targetTabId: 17, prompt: 'hello',
    });

    const response = router.fromContent(content17 as never, {
      protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    });
    router.setContentPort(replacement as never);
    resolveResponseLookup({ id: 17, url: 'https://chat.deepseek.com/' });
    await response;

    expect(sidePanel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    }));
    expect(sidePanel.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'CONTENT_ERROR', requestId: 'req-1', code: 'TAB_IDENTITY_LOST',
    }));
  });

  it('settles a request before a disconnected Port rejects a notification', async () => {
    const sidePanel = makePort('kcode-sidepanel');
    const content17 = makePort('kcode-content', 17);
    content17.postMessage.mockImplementation(() => { throw new Error('Port disconnected'); });
    const router = new PortRouter({
      tabs: { get: vi.fn().mockResolvedValue({ id: 17, url: 'https://chat.deepseek.com/' }) },
    });
    router.setSidePanelPort(sidePanel as never);
    router.setContentPort(content17 as never);

    await expect(router.fromSidePanel({
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-1', targetTabId: 17, prompt: 'hello',
    })).resolves.toBeUndefined();
    await router.fromContent(content17 as never, {
      protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    });

    expect(sidePanel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    }));
  });

  it('settles a terminal response before a disconnected Side Panel rejects it', async () => {
    const sidePanel = makePort('kcode-sidepanel');
    sidePanel.postMessage.mockImplementation(() => { throw new Error('Port disconnected'); });
    const content17 = makePort('kcode-content', 17);
    const router = new PortRouter({
      tabs: { get: vi.fn().mockResolvedValue({ id: 17, url: 'https://chat.deepseek.com/' }) },
    });
    router.setSidePanelPort(sidePanel as never);
    router.setContentPort(content17 as never);
    await router.fromSidePanel({
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-1', targetTabId: 17, prompt: 'hello',
    });

    await expect(router.fromContent(content17 as never, {
      protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    })).resolves.toBeUndefined();
    sidePanel.postMessage.mockClear();
    await router.fromContent(content17 as never, {
      protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-1',
    });

    expect(sidePanel.postMessage).not.toHaveBeenCalled();
  });

  it('does not throw when an identity-loss notification reaches a disconnected Side Panel', async () => {
    const sidePanel = makePort('kcode-sidepanel');
    sidePanel.postMessage.mockImplementation(() => { throw new Error('Port disconnected'); });
    const router = new PortRouter({
      tabs: { get: vi.fn() },
    });
    router.setSidePanelPort(sidePanel as never);

    await expect(router.fromSidePanel({
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-1', targetTabId: 17, prompt: 'hello',
    })).resolves.toBeUndefined();
  });
});
