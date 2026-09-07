import { describe, expect, it, vi } from 'vitest';
import { VMClient } from '../../src/sidepanel/vm-client';

type Listener<T> = (event: T) => void;

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;
  throwOnPost = false;

  postMessage(message: unknown): void { if (this.throwOnPost) throw new Error('disconnected'); this.posted.push(message); }
  terminate(): void { this.terminated = true; }
  emit(message: unknown): void { this.onmessage?.({ data: message } as MessageEvent); }
}

describe('VMClient', () => {
  it('routes stdin only to a live persistent execution and keeps input acknowledgements separate', async () => {
    const worker = new FakeWorker();
    const client = new VMClient(() => worker as unknown as Worker);
    await expect(client.sendInput('x')).rejects.toThrow('VM_STDIN_NOT_READY');
    const boot = client.start({ mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read'], network: { mode: 'offline' } }, 'standard', true);
    worker.emit({ kind: 'VM_READY', requestId: (worker.posted.at(-1) as any).requestId });
    await boot;
    const execution = client.exec('read answer', { timeoutMs: 30000 });
    const requestId = (worker.posted.at(-1) as any).requestId;
    let finished = false;
    void execution.then(() => { finished = true; });
    await expect(client.sendInput('你'.repeat(3000))).rejects.toThrow('VM_STDIN_TOO_LARGE');
    const input = client.sendInput('hello\r');
    expect(worker.posted.at(-1)).toMatchObject({ kind: 'VM_STDIN', targetRequestId: requestId, data: 'hello\r' });
    worker.emit({ kind: 'VM_READY', requestId: (worker.posted.at(-1) as any).requestId });
    await input;
    expect(finished).toBe(false);
    worker.emit({ kind: 'VM_RESULT', requestId, output: 'hello', exitCode: 0, truncated: false, durationMs: 1, transactionId: 'no_transaction', journalSummary: { transactionId: 'no_transaction', state: 'clean', entries: [], journalBytes: 0, writtenBytes: 0 } });
    await execution;
    await expect(client.sendInput('later')).rejects.toThrow('VM_STDIN_NOT_READY');
    client.dispose();
  });


  it('rejects malformed correlated file results instead of hanging', async () => {
    const worker = new FakeWorker();
    const client = new VMClient(() => worker as unknown as Worker);
    const pending = client.writeFile('index.html', 'hello');
    const request = worker.posted[0] as { requestId: string };
    worker.emit({ kind: 'VM_FILE_RESULT', requestId: request.requestId, durationMs: 0.25 });
    await expect(pending).rejects.toThrow('VM_PROTOCOL_ERROR');
    expect(worker.terminated).toBe(true);
  });

  it('bounds a missing file response', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const client = new VMClient(() => worker as unknown as Worker);
      const pending = client.writeFile('index.html', 'hello');
      const assertion = expect(pending).rejects.toThrow('VM_REQUEST_TIMEOUT');
      await vi.advanceTimersByTimeAsync(60000);
      await assertion;
      expect(worker.terminated).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('reuses a persistent Worker and mount after file commit and updates authority between operations', async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker as unknown as Worker);
    const client = new VMClient(factory);
    const session = { mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read', 'write'], network: { mode: 'offline' } } as const;
    const ready = async (pending: Promise<void>) => {
      const request = worker.posted.at(-1) as { requestId: string };
      worker.emit({ kind: 'VM_READY', requestId: request.requestId }); await pending;
    };
    await ready(client.start(session, 'standard', true));
    const handle = {} as FileSystemDirectoryHandle;
    await ready(client.attachWorkspace(handle));
    await ready(client.beginTransaction('tx_file'));
    const pending = client.writeFile('index.html', 'hello');
    const request = worker.posted.at(-1) as { requestId: string };
    worker.emit({ kind: 'VM_FILE_RESULT', requestId: request.requestId, text: '', truncated: false, durationMs: 1, transactionId: 'tx_file', journalSummary: { transactionId: 'tx_file', state: 'dirty', entries: [], journalBytes: 1, writtenBytes: 5 } });
    await pending;
    await ready(client.commitTransaction());
    await ready(client.start({ ...session, capabilities: ['read'] }, 'standard', true));
    expect(worker.posted.at(-1)).toMatchObject({ kind: 'VM_UPDATE_SESSION', session: { capabilities: ['read'] } });
    await client.attachWorkspace(handle);
    expect(worker.posted.filter((item: any) => item.kind === 'VM_ATTACH_WORKSPACE')).toHaveLength(1);
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(false);
    client.dispose();
  });

  it('native-terminates the old generation before a high-memory cold boot', async () => {
    // Break caught: keeping a Worker, cloned handle, or pending request across a RAM-profile change can restore state from a different VM geometry.
    const standardWorker = new FakeWorker();
    const highWorker = new FakeWorker();
    const workers = [standardWorker, highWorker];
    const client = new VMClient(() => workers.shift() as unknown as Worker);
    const standard = client.start({ mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read'], network: { mode: 'offline' } });
    client.selectMemoryProfile('high');
    const high = client.start({ mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read'], network: { mode: 'offline' } });

    expect(standardWorker.terminated).toBe(true);
    await expect(standard).rejects.toThrow('VM_MEMORY_PROFILE_CHANGED');
    expect(highWorker.posted).toHaveLength(1);
    expect(highWorker.posted[0]).toMatchObject({ kind: 'VM_INIT', memoryProfile: 'high' });
    const [boot] = highWorker.posted as Array<{ requestId: string }>;
    highWorker.emit({ kind: 'VM_READY', requestId: boot.requestId });
    await expect(high).resolves.toBeUndefined();
  });

  it('uses a new native Worker for every explicit session restart even at the same memory profile', async () => {
    // Break caught: a second VM_INIT posted to the same Worker can retain the first session's mount and authorization state.
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const client = new VMClient(() => workers.shift() as unknown as Worker);
    const session = { mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read'], network: { mode: 'offline' } } as const;
    const first = client.start(session);

    const second = client.start(session);

    expect(firstWorker.terminated).toBe(true);
    await expect(first).rejects.toThrow('VM_SESSION_RESTARTED');
    expect(secondWorker.posted).toHaveLength(1);
    const [boot] = secondWorker.posted as Array<{ requestId: string }>;
    secondWorker.emit({ kind: 'VM_READY', requestId: boot.requestId });
    await expect(second).resolves.toBeUndefined();
  });

  it.each([384 * 1024 + 1, 1024 * 1024])('resolves a retained result of %d bytes instead of misclassifying completion as a watchdog failure', async (bytes) => {
    // Break caught: VM_RESULT schema rejection above the old Port limit leaves an already-completed command pending until the watchdog fires.
    const worker = new FakeWorker();
    const client = new VMClient(() => worker as unknown as Worker);
    const pending = client.exec('verbose', { timeoutMs: 120_000 });
    const [request] = worker.posted as Array<{ requestId: string }>;
    const output = 'a'.repeat(bytes);

    worker.emit({ kind: 'VM_RESULT', requestId: request.requestId, output, exitCode: 0, truncated: false, durationMs: 1, transactionId: 'no_transaction', journalSummary: { transactionId: 'no_transaction', state: 'clean', entries: [], journalBytes: 0, writtenBytes: 0 } });

    await expect(pending).resolves.toMatchObject({ output, exitCode: 0 });
  });

  it('correlates a confined read_file result and retires its read-only Worker', async () => {
    // Break caught: implementing read_file as shell syntax or leaving its Worker alive would violate confinement and disposal.
    const worker = new FakeWorker();
    const client = new VMClient(() => worker as unknown as Worker);
    const pending = client.readFile('src/main.ts', 1024);
    const [request] = worker.posted as Array<{ kind: string; requestId: string; path: string; maxBytes: number }>;
    expect(request).toMatchObject({ kind: 'VM_READ_FILE', path: 'src/main.ts', maxBytes: 1024 });
    worker.emit({ kind: 'VM_FILE_RESULT', requestId: request.requestId, text: 'file', truncated: false, durationMs: 1, transactionId: 'no_transaction', journalSummary: { transactionId: 'no_transaction', state: 'clean', entries: [], journalBytes: 0, writtenBytes: 0 } });
    await expect(pending).resolves.toMatchObject({ text: 'file', transactionId: 'no_transaction' });
    expect(worker.terminated).toBe(true);
  });

  it('keeps a write_file journal generation alive until rollback', async () => {
    // Break caught: retiring immediately after a direct mutation makes its durable journal impossible to accept or roll back explicitly.
    const worker = new FakeWorker();
    const client = new VMClient(() => worker as unknown as Worker);
    const begin = client.beginTransaction('tx_file');
    const [beginRequest] = worker.posted as Array<{ requestId: string }>;
    worker.emit({ kind: 'VM_READY', requestId: beginRequest.requestId });
    await begin;
    const pending = client.writeFile('notes.txt', 'safe');
    const request = worker.posted[1] as { kind: string; requestId: string; path: string; content: string };
    expect(request).toMatchObject({ kind: 'VM_WRITE_FILE', path: 'notes.txt', content: 'safe' });
    worker.emit({ kind: 'VM_FILE_RESULT', requestId: request.requestId, text: '', truncated: false, durationMs: 1, transactionId: 'tx_file', journalSummary: { transactionId: 'tx_file', state: 'dirty', entries: [], journalBytes: 1, writtenBytes: 4 } });
    await pending;
    expect(worker.terminated).toBe(false);
  });

  it('retires a no-transaction Worker before creating the next disposable generation', async () => {
    // Break caught: retaining a closed Worker after its one-command result makes a subsequent start post to a dead worker and hang.
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const client = new VMClient(() => workers.shift() as unknown as Worker);
    const first = client.exec('pwd', { timeoutMs: 120_000 });
    const [execution] = firstWorker.posted as Array<{ requestId: string }>;
    firstWorker.emit({ kind: 'VM_RESULT', requestId: execution.requestId, output: '/work', exitCode: 0, truncated: false, durationMs: 1, transactionId: 'no_transaction', journalSummary: { transactionId: 'no_transaction', state: 'clean', entries: [], journalBytes: 0, writtenBytes: 0 } });
    await first;

    const next = client.start({ mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read'], network: { mode: 'offline' } });
    expect(firstWorker.terminated).toBe(true);
    expect(secondWorker.posted).toHaveLength(1);
    const [boot] = secondWorker.posted as Array<{ requestId: string }>;
    secondWorker.emit({ kind: 'VM_READY', requestId: boot.requestId });
    await expect(next).resolves.toBeUndefined();
  });

  it('retires a finalizing Worker before resolving a commit that can be followed by a new start', async () => {
    // Break caught: self.close has no observable close event, so without explicit native retirement a post-finalization request targets a stale Worker.
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const client = new VMClient(() => workers.shift() as unknown as Worker);
    const commit = client.commitTransaction();
    const [request] = firstWorker.posted as Array<{ requestId: string }>;
    firstWorker.emit({ kind: 'VM_READY', requestId: request.requestId });
    await commit;

    const next = client.start({ mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read'], network: { mode: 'offline' } });
    expect(firstWorker.terminated).toBe(true);
    expect(secondWorker.posted).toHaveLength(1);
    const [boot] = secondWorker.posted as Array<{ requestId: string }>;
    secondWorker.emit({ kind: 'VM_READY', requestId: boot.requestId });
    await next;
  });

  it('rejects a second execution while the disposable VM is busy', async () => {
    // Break caught: concurrent shell requests can cross serial framing and make two hostile guest processes share one containment boundary.
    const worker = new FakeWorker();
    const client = new VMClient(() => worker as unknown as Worker);
    const first = client.exec('pwd', { timeoutMs: 120_000 });
    await expect(client.exec('id', { timeoutMs: 120_000 })).rejects.toThrow('VM_EXEC_BUSY');
    const [firstRequest] = worker.posted as Array<{ requestId: string }>;

    const result = (requestId: string, output: string) => ({ kind: 'VM_RESULT' as const, requestId, output, exitCode: 0, truncated: false, durationMs: 1, transactionId: 'tx_1', journalSummary: { transactionId: 'tx_1', state: 'clean' as const, entries: [], journalBytes: 0, writtenBytes: 0 } });
    worker.emit(result(firstRequest.requestId, '/work'));
    await expect(first).resolves.toEqual({ output: '/work', exitCode: 0, truncated: false, durationMs: 1, transactionId: 'tx_1', journalSummary: { transactionId: 'tx_1', state: 'clean', entries: [], journalBytes: 0, writtenBytes: 0 } });
  });

  it('rejects all pending calls when the worker crashes', async () => {
    // Break caught: a crashed worker leaves caller promises hanging indefinitely.
    const worker = new FakeWorker();
    const client = new VMClient(() => worker as unknown as Worker);
    const pending = client.exec('pwd', { timeoutMs: 120_000 });
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(pending).rejects.toThrow('VM_WORKER_CRASHED');
  });

  it('synchronously terminates and rejects pending calls once', async () => {
    // Break caught: stop leaves a cloned handle or a live pending VM operation behind.
    const worker = new FakeWorker();
    const lifecycle = vi.fn();
    const client = new VMClient(() => worker as unknown as Worker);
    client.subscribe(lifecycle);
    const pending = client.exec('pwd', { timeoutMs: 120_000 });

    client.terminate('USER_STOP');

    expect(worker.terminated).toBe(true);
    expect(lifecycle).toHaveBeenCalledWith({ kind: 'terminated', reason: 'USER_STOP' });
    await expect(pending).rejects.toThrow('USER_STOP');
    client.terminate('SECOND_STOP');
    expect(lifecycle).toHaveBeenCalledTimes(1);
  });

  it('terminates and recreates the worker when attaching the directory handle cannot post', async () => {
    // Break caught: a failed structured-clone post leaves a live worker or cloned workspace authority behind.
    const failedWorker = new FakeWorker();
    failedWorker.throwOnPost = true;
    const replacementWorker = new FakeWorker();
    const workers = [failedWorker, replacementWorker];
    const lifecycle = vi.fn();
    const client = new VMClient(() => workers.shift() as unknown as Worker);
    client.subscribe(lifecycle);

    await expect(client.attachWorkspace({} as FileSystemDirectoryHandle)).rejects.toThrow('VM_WORKER_UNAVAILABLE');
    expect(failedWorker.terminated).toBe(true);
    expect(lifecycle).toHaveBeenCalledWith({ kind: 'terminated', reason: 'VM_WORKER_UNAVAILABLE' });
    client.exec('pwd', { timeoutMs: 120_000 });
    expect(replacementWorker.posted).toHaveLength(1);
  });
});
