// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';
import App, { sidePanelServicesKey, type SidePanelServices } from '../../src/sidepanel/App.vue';
import { TabClient } from '../../src/sidepanel/tab-client';

const fakeServices = (ready = false): SidePanelServices => ({
  workspace: {
    load: vi.fn().mockResolvedValue(ready ? { workspaceId: 'workspace-1', handle: {} } : null),
    selectDirectory: vi.fn(),
    getPermission: vi.fn().mockResolvedValue(ready ? 'granted' : 'prompt'),
    requestReadWrite: vi.fn().mockResolvedValue('granted'),
  },
  tab: { listConnectedTabs: vi.fn().mockResolvedValue(ready ? [{ id: 7, title: 'DeepSeek' }] : []), sendPrompt: vi.fn() },
  vm: { terminate: vi.fn(), attachWorkspace: vi.fn(), start: vi.fn(), exec: vi.fn(), subscribe: vi.fn(() => () => {}) },
  consent: { grant: vi.fn(), hasValid: vi.fn().mockResolvedValue(false), revokeAll: vi.fn() },
});

afterEach(() => cleanup());

describe('Side Panel shell', () => {
  it('lists only tabs reported by the authenticated background Port', async () => {
    // Break caught: the panel calls chrome.tabs.query or accepts a mismatched listing response.
    let listener: ((message: unknown) => void) | undefined;
    const port = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn((next) => { listener = next; }) },
      onDisconnect: { addListener: vi.fn() },
    };
    const client = new TabClient(() => port as unknown as chrome.runtime.Port);
    const pending = client.listConnectedTabs();
    const request = port.postMessage.mock.calls[0][0] as { requestId: string };
    listener?.({ protocolVersion: 1, kind: 'SIDE_PANEL_CONNECTED_TABS', requestId: 'wrong', tabs: [{ tabId: 4, title: 'Wrong' }] });
    listener?.({ protocolVersion: 1, kind: 'SIDE_PANEL_CONNECTED_TABS', requestId: request.requestId, tabs: [{ tabId: 7, title: 'DeepSeek' }] });

    await expect(pending).resolves.toEqual([{ id: 7, title: 'DeepSeek' }]);
  });

  it('keeps submit disabled until directory and DeepSeek are ready', async () => {
    // Break caught: a prompt can begin without both the workspace and authenticated content connection.
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: fakeServices(false) } } });
    const submit = await screen.findByRole('button', { name: '开始任务' });
    expect(submit).toHaveProperty('disabled', true);
  });

  it('requires every relevant warning check before an auto enable gesture', async () => {
    // Break caught: merely toggling auto, or checking only a subset of warnings, activates high-risk mode.
    const services = fakeServices(true);
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('button', { name: '开始任务' });
    await fireEvent.click(screen.getByRole('checkbox', { name: '启用 Auto' }));
    const enable = await screen.findByRole('button', { name: '启用 Auto' });
    expect(enable).toHaveProperty('disabled', true);
    for (const box of screen.getAllByRole('checkbox', { name: /AI 可以|仓库|工具结果|操作可能/ })) await fireEvent.click(box);
    expect(enable).toHaveProperty('disabled', false);
    await fireEvent.click(enable);
    expect(services.workspace.requestReadWrite).toHaveBeenCalledTimes(1);
    expect(services.consent.grant).toHaveBeenCalledWith(['auto'], { workspaceId: 'workspace-1', relayUrl: null });
  });

  it('stops and revokes active high-risk mode when the relay URL changes', async () => {
    // Break caught: a new relay path keeps authority granted for the old normalized full relay URL.
    const services = fakeServices(true);
    render(App, { global: { provide: { [sidePanelServicesKey as symbol]: services } } });
    await screen.findByRole('button', { name: '开始任务' });
    await fireEvent.click(screen.getByRole('checkbox', { name: '连接工作区网络' }));
    const relay = await screen.findByRole('textbox', { name: 'WISP relay URL' });
    await fireEvent.update(relay, 'wss://relay.example/first');
    for (const box of screen.getAllByRole('checkbox', { name: /启用网络后|WISP 中继/ })) await fireEvent.click(box);
    await fireEvent.click(screen.getByRole('button', { name: '启用 Auto' }));
    await screen.findByText('网络：wisp');
    await fireEvent.update(relay, 'wss://relay.example/second');

    await screen.findByText('网络：offline');
    expect(services.vm.terminate).toHaveBeenCalledWith('RELAY_URL_CHANGED');
    expect(services.consent.revokeAll).toHaveBeenCalledTimes(2);
  });
});
