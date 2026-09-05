import { describe, expect, it, vi } from 'vitest';
import { RelaySettingsStore } from '../../src/sidepanel/relay-settings';

const storageArea = (initial: Record<string, unknown> = {}) => {
  const values = { ...initial };
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
};

describe('RelaySettingsStore', () => {
  it('stores only the normalized complete WISP URL', async () => {
    // Break caught: durable settings retain ambiguous/default ports or extra attacker-controlled fields.
    const storage = storageArea();
    const store = new RelaySettingsStore(storage);

    await expect(store.save('wss://relay.example:443/wisp')).resolves.toBe('wss://relay.example/wisp');
    expect(storage.set).toHaveBeenCalledWith({ 'kcode.wisp-relay-url': 'wss://relay.example/wisp' });
    await expect(store.load()).resolves.toBe('wss://relay.example/wisp');
  });

  it('rejects unsafe input without modifying trusted storage', async () => {
    // Break caught: credentials/query tokens are persisted and later silently become network authority.
    const storage = storageArea();
    const store = new RelaySettingsStore(storage);

    await expect(store.save('wss://relay.example/wisp?token=secret')).rejects.toThrow('INVALID_RELAY_URL');
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('removes a malformed durable value instead of restoring it into the UI', async () => {
    // Break caught: a legacy or externally corrupted setting bypasses the current strict validator on restore.
    const storage = storageArea({ 'kcode.wisp-relay-url': 'ws://relay.example/wisp' });
    const store = new RelaySettingsStore(storage);

    await expect(store.load()).resolves.toBeNull();
    expect(storage.remove).toHaveBeenCalledWith('kcode.wisp-relay-url');
  });
});
