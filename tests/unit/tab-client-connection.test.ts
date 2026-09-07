import { describe, expect, it, vi } from 'vitest';
import { TabClient } from '../../src/sidepanel/tab-client';
const fakePort = () => {
  let receive: (value: unknown) => void = () => undefined;
  let disconnect: () => void = () => undefined;
  return { postMessage: vi.fn(), disconnect: vi.fn(), onMessage: { addListener: (fn: typeof receive) => { receive = fn; } }, onDisconnect: { addListener: (fn: typeof disconnect) => { disconnect = fn; } }, emit: (value: unknown) => receive(value), drop: () => disconnect() };
};
describe('connection query and recovery', () => {
  it('uses an independent query and reconnects a lost Port without replaying messages', async () => {
    const ports = [fakePort(), fakePort()]; let next = 0;
    const factory = vi.fn(() => ports[next++] as unknown as chrome.runtime.Port);
    const query = vi.fn(async (message: any) => ({ protocolVersion: 1, kind: 'SIDE_PANEL_CONNECTED_TABS', requestId: message.requestId, tabs: [{ tabId: 1, title: 'chat', provider: 'ChatGPT' }] }));
    const client = new TabClient(factory, query);
    expect(await client.listConnectedTabs()).toEqual([{ id: 1, title: 'chat', provider: 'ChatGPT' }]);
    expect(ports[0]!.postMessage).not.toHaveBeenCalled();
    ports[0]!.drop();
    await client.listConnectedTabs();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
    expect(ports[1]!.postMessage).not.toHaveBeenCalled();
    client.dispose();
  });
  it('bounds an unanswered one-shot query', async () => {
    vi.useFakeTimers();
    try {
      const client = new TabClient(() => fakePort() as unknown as chrome.runtime.Port, () => new Promise(() => undefined));
      const pending = expect(client.listConnectedTabs()).rejects.toThrow('TAB_DISCOVERY_TIMEOUT');
      await vi.advanceTimersByTimeAsync(5000); await pending; client.dispose();
    } finally { vi.useRealTimers(); }
  });
});

it('preserves the content adapter diagnostic alongside its error code', async () => {
  const port = fakePort(); const client = new TabClient(() => port as unknown as chrome.runtime.Port);
  const pending = client.sendPrompt(1, 'hello');
  const request = port.postMessage.mock.calls[0][0];
  const detail = '发送前 · 发送按钮（可见 1 个；0 个可用，其余被禁用）';
  port.emit({ protocolVersion: 1, kind: 'CONTENT_ERROR', requestId: request.requestId, sourceTabId: 1, code: 'ADAPTER_DOM_CHANGED', message: detail });
  await expect(pending).rejects.toMatchObject({ message: 'ADAPTER_DOM_CHANGED', detail });
  client.dispose();
});
