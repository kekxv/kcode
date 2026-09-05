import { describe, expect, it, vi } from 'vitest';
import { WorkHistoryStore } from '../../src/sidepanel/work-history';

const storageArea = () => {
  const values: Record<string, unknown> = {};
  return { values, get: vi.fn(async (key: string) => ({ [key]: values[key] })), set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }), remove: vi.fn(async (key: string) => { delete values[key]; }) };
};

describe('WorkHistoryStore', () => {
  it('persists and reloads a bounded local work record', async () => {
    // Break caught: a completed run disappears after the side panel reloads.
    const storage = storageArea(); const store = new WorkHistoryStore(storage);
    const record = { id: 'run-1', createdAt: 1, provider: 'HIX.AI' as const, task: 'summarize', outcome: 'done', status: 'completed' as const };
    await expect(store.append(record)).resolves.toEqual([record]);
    await expect(store.load()).resolves.toEqual([record]);
  });

  it('clears malformed durable data rather than exposing it', async () => {
    // Break caught: corrupt local storage is rendered as a past task.
    const storage = storageArea(); storage.values['kcode.work-history.v1'] = { records: 'bad' };
    await expect(new WorkHistoryStore(storage).load()).resolves.toEqual([]);
    expect(storage.remove).toHaveBeenCalledWith('kcode.work-history.v1');
  });

  it('retains more than one hundred work events before applying its bounded eviction policy', async () => {
    // Break caught: one agent run emits over 100 tool/turn events and silently loses its early work record.
    const storage = storageArea(); const store = new WorkHistoryStore(storage);
    for (let index = 0; index < 101; index += 1) {
      await store.append({ id: `run-${index}`, createdAt: index, provider: 'HIX.AI', task: 'task', outcome: 'event', status: 'completed' });
    }
    await expect(store.load()).resolves.toHaveLength(101);
  });
});
