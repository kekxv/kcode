import { describe, expect, it, vi } from 'vitest';
import { WorkHistoryStore } from '../../src/sidepanel/work-history';
import { WorkspaceHistoryStore } from '../../src/sidepanel/workspace-history';
import { MemoryFsaRoot } from '../helpers/memory-fsa';

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

  it('stores and clears SQLite history only inside the selected .session directory', async () => {
    // Break caught: durable history is written outside the selected workspace or clear leaves the database behind.
    const root = new MemoryFsaRoot(); const store = new WorkspaceHistoryStore();
    const record = { id: 'sqlite-1', createdAt: 1, provider: 'HIX.AI' as const, task: 'task', outcome: 'done', status: 'completed' as const };
    await store.append(root as unknown as FileSystemDirectoryHandle, record);
    await expect(store.load(root as unknown as FileSystemDirectoryHandle)).resolves.toEqual([record]);
    const session = await root.getDirectoryHandle('.session');
    await expect(session.getFileHandle('kcode-history.sqlite')).resolves.toBeTruthy();
    await store.clear(root as unknown as FileSystemDirectoryHandle);
    await expect(session.getFileHandle('kcode-history.sqlite')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('does not create a .session directory when history has not been explicitly enabled', async () => {
    // Break caught: merely opening the side panel mutates the selected
    // workspace and prompts for write access before the user opts in.
    const root = new MemoryFsaRoot(); const store = new WorkspaceHistoryStore();
    await expect(store.load(root as unknown as FileSystemDirectoryHandle)).resolves.toEqual([]);
    await expect(root.getDirectoryHandle('.session')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('persists a redacted resumable checkpoint separately from audit history', async () => {
    // Break caught: a browser restart loses the task that was in progress, or
    // a checkpoint is confused with a completed audit record.
    const root = new MemoryFsaRoot(); const store = new WorkspaceHistoryStore();
    const checkpoint = {
      updatedAt: 1,
      provider: 'Qwen' as const,
      task: '继续处理 [REDACTED:github-token]',
      phase: 'running' as const,
      summary: '已写入 notes.txt',
    };
    await store.saveRecovery(root as unknown as FileSystemDirectoryHandle, checkpoint);
    await expect(store.loadRecovery(root as unknown as FileSystemDirectoryHandle)).resolves.toEqual(checkpoint);
    await store.clearRecovery(root as unknown as FileSystemDirectoryHandle);
    await expect(store.loadRecovery(root as unknown as FileSystemDirectoryHandle)).resolves.toBeNull();
  });
});

it('round-trips a full transcript with long output, tool arguments and image attachments', async () => {
  const root = new MemoryFsaRoot();
  const handle = root as unknown as FileSystemDirectoryHandle;
  const store = new WorkspaceHistoryStore();
  const legacy = { id: 'legacy', createdAt: 1, provider: 'Qwen' as const, task: '旧任务', outcome: '摘要', status: 'completed' as const };
  await store.append(handle, legacy);
  const record = { ...legacy, id: 'full', createdAt: 2, messages: [
    { role: 'user' as const, text: '生成图片说明', images: [{ name: 'test.png', dataUrl: 'data:image/png;base64,YQ==' }] },
    { role: 'assistant' as const, text: '先读取文件。' },
    { role: 'tool' as const, text: '', tool: { id: 'read', tool: 'read_file' as const, args: { path: 'large.txt' } }, status: 'done' as const, result: { text: '长输出'.repeat(100_000), exitCode: 0, truncated: false, durationMs: 12 } },
    { role: 'assistant' as const, text: '完整结果' },
  ] };
  await store.append(handle, record);
  await expect(new WorkspaceHistoryStore().load(handle)).resolves.toEqual([record, legacy]);
});
