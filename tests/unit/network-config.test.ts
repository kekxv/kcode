import { describe, expect, it } from 'vitest';
import { toV86NetDevice, validateRelayUrl } from '../../src/worker/network-config';

describe('WISP network configuration', () => {
  it.each([
    ['wss://relay.example/wisp', 'wss://relay.example/wisp', 'wss://relay.example', 'wisps://relay.example/wisp'],
    ['wss://relay.example:8443/wisp/v2', 'wss://relay.example:8443/wisp/v2', 'wss://relay.example:8443', 'wisps://relay.example:8443/wisp/v2'],
    ['wss://10.0.0.5:4443/', 'wss://10.0.0.5:4443/', 'wss://10.0.0.5:4443', 'wisps://10.0.0.5:4443/'],
    ['wss://[2001:db8::1]/wisp', 'wss://[2001:db8::1]/wisp', 'wss://[2001:db8::1]', 'wisps://[2001:db8::1]/wisp'],
  ])('normalizes and maps %s', (input, websocketUrl, relayOrigin, v86RelayUrl) => {
    expect(validateRelayUrl(input)).toEqual({ websocketUrl, relayOrigin, v86RelayUrl });
    expect(toV86NetDevice({ mode: 'wisp', relayUrl: input })).toEqual({ type: 'virtio', relay_url: v86RelayUrl });
  });

  it('keeps offline guests NIC-free', () => {
    expect(toV86NetDevice({ mode: 'offline' })).toBeUndefined();
  });

  it.each([
    'ws://relay.example/wisp',
    'https://relay.example/wisp',
    'wss://user:pass@relay.example/wisp',
    'wss://relay.example/wisp?token=x',
    'wss://relay.example/wisp#fragment',
    ' wss://relay.example/wisp',
    'wss://relay.example/wisp\n',
    'wss://relay.example/%2e%2e/private',
    'wss:///wisp',
  ])('rejects unsafe relay input %j', (input) => {
    expect(() => validateRelayUrl(input)).toThrow('INVALID_RELAY_URL');
  });

  it('rejects a serialized URL above 2048 UTF-8 bytes', () => {
    expect(() => validateRelayUrl(`wss://relay.example/${'a'.repeat(2048)}`)).toThrow('INVALID_RELAY_URL');
  });
});
