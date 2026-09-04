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
  it('resolves only the matching worker terminal event', async () => {
    // Break caught: accepting a result for another RPC request can cross command outputs.
    const worker = new FakeWorker();
    const client = new VMClient(() => worker as unknown as Worker);
    const first = client.exec('pwd', { timeoutMs: 120_000 });
    const second = client.exec('id', { timeoutMs: 120_000 });
    const [firstRequest, secondRequest] = worker.posted as Array<{ requestId: string }>;

    worker.emit({ kind: 'VM_RESULT', requestId: secondRequest.requestId, output: 'uid=1000', exitCode: 0 });
    await expect(second).resolves.toEqual({ output: 'uid=1000', exitCode: 0 });
    worker.emit({ kind: 'VM_RESULT', requestId: firstRequest.requestId, output: '/workspace', exitCode: 0 });
    await expect(first).resolves.toEqual({ output: '/workspace', exitCode: 0 });
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
