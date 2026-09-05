import { describe, expect, it, vi } from 'vitest';
import { AgentSettingsStore } from '../../src/sidepanel/agent-settings';

const storageArea = (initial: Record<string, unknown> = {}) => {
  const values = { ...initial };
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
};

describe('AgentSettingsStore', () => {
  it('persists a bounded user-authored supplemental instruction locally', async () => {
    // Break caught: user instructions disappear on reload or are stored under a broad/unrelated settings key.
    const storage = storageArea();
    const store = new AgentSettingsStore(storage);

    await expect(store.save('Use concise Chinese responses.')).resolves.toBe('Use concise Chinese responses.');
    expect(storage.set).toHaveBeenCalledWith({ 'kcode.agent-instructions': 'Use concise Chinese responses.' });
    await expect(store.load()).resolves.toBe('Use concise Chinese responses.');
  });

  it('rejects oversized instructions without writing them', async () => {
    // Break caught: a saved prompt can exceed the page-port budget or make every task unusable.
    const storage = storageArea();
    const store = new AgentSettingsStore(storage);

    await expect(store.save('x'.repeat(16 * 1024 + 1))).rejects.toThrow('AGENT_INSTRUCTIONS_TOO_LARGE');
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('clears malformed durable settings rather than returning them to a task', async () => {
    // Break caught: corrupt storage restores a non-string or oversized instruction into a later task.
    const storage = storageArea({ 'kcode.agent-instructions': { text: 'not allowed' } });
    const store = new AgentSettingsStore(storage);

    await expect(store.load()).resolves.toBe('');
    expect(storage.remove).toHaveBeenCalledWith('kcode.agent-instructions');
  });
});
