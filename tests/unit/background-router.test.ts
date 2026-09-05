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
  it('forwards an authenticated side-panel cancellation only to the matching pending content request', async () => {
    // Break caught: local cancellation without router cleanup leaves the page observer streaming into a later task.
    const sidePanel = makePort('kcode-sidepanel');
    const content = makePort('kcode-content', 17);
    const router = new PortRouter({ tabs: { get: vi.fn().mockResolvedValue({ id: 17, url: 'https://chat.deepseek.com/' }) } });
    router.setSidePanelPort(sidePanel as never);
    router.setContentPort(content as never);
    await router.fromSidePanel({ protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-cancel', targetTabId: 17, prompt: 'hello' });
    content.postMessage.mockClear();

    await router.fromSidePanel({ protocolVersion: 1, kind: 'CONTENT_ABORT_REQUEST', requestId: 'req-cancel', targetTabId: 17 });

    expect(content.postMessage).toHaveBeenCalledWith({ protocolVersion: 1, kind: 'CONTENT_ABORT_REQUEST', requestId: 'req-cancel' });
    content.postMessage.mockClear();
    await router.fromContent(content as never, { protocolVersion: 1, kind: 'CONTENT_RESPONSE_DONE', requestId: 'req-cancel' });
    expect(sidePanel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-cancel', kind: 'CONTENT_RESPONSE_DONE' }));
  });

  it('aborts the active content request when its owning side-panel session is replaced', async () => {
    // Break caught: deleting router pending state without notifying content leaves the old page observer active.
    const originalPanel = makePort('kcode-sidepanel');
    const replacementPanel = makePort('kcode-sidepanel');
    const content = makePort('kcode-content', 17);
    const router = new PortRouter({
      tabs: { get: vi.fn().mockResolvedValue({ id: 17, url: 'https://chat.deepseek.com/' }) },
    });
    router.setSidePanelPort(originalPanel as never);
    router.setContentPort(content as never);
    await router.fromSidePanel({
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-session', targetTabId: 17, prompt: 'hello',
    });
    content.postMessage.mockClear();

    router.setSidePanelPort(replacementPanel as never);

    expect(content.postMessage).toHaveBeenCalledWith({
      protocolVersion: 1, kind: 'CONTENT_ABORT_REQUEST', requestId: 'req-session',
    });
  });

  it('aborts the old content controller when its authenticated Port is replaced', async () => {
    // Break caught: replacing the tab Port without cancellation lets the stale content script continue observing the page.
    const panel = makePort('kcode-sidepanel');
    const oldContent = makePort('kcode-content', 17);
    const replacement = makePort('kcode-content', 17);
    const router = new PortRouter({
      tabs: { get: vi.fn().mockResolvedValue({ id: 17, url: 'https://chat.deepseek.com/' }) },
    });
    router.setSidePanelPort(panel as never);
    router.setContentPort(oldContent as never);
    await router.fromSidePanel({
      protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'req-port', targetTabId: 17, prompt: 'hello',
    });
    oldContent.postMessage.mockClear();

    router.setContentPort(replacement as never);

    expect(oldContent.postMessage).toHaveBeenCalledWith({
      protocolVersion: 1, kind: 'CONTENT_ABORT_REQUEST', requestId: 'req-port',
    });
  });

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

  it('does not report identity loss twice when a replaced content port lookup rejects', async () => {
    let rejectResponseLookup!: (reason?: unknown) => void;
    const responseLookup = new Promise<{ id: number; url: string }>((_resolve, reject) => { rejectResponseLookup = reject; });
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
    rejectResponseLookup(new Error('tab gone'));
    await response;

    const identityLosses = sidePanel.postMessage.mock.calls.filter(([event]) =>
      (event as { code?: string }).code === 'TAB_IDENTITY_LOST',
    );
    expect(identityLosses).toHaveLength(1);
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
