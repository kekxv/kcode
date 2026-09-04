import { createRequestId, isVMEvent, type VMEvent, type VMRequest, type WorkspaceSession } from '../types/protocol';
import { VMWatchdog, type WatchdogRun } from './vm-watchdog';
import type { JournalSummary } from '../worker/p9/mutation-journal';

type Deferred<T> = { resolve: (value: T) => void; reject: (reason: Error) => void };
type Pending = Deferred<void | VMExecutionResult>;

export type VMExecutionResult = { output: string; exitCode: number; truncated: boolean; durationMs: number; transactionId: string; journalSummary: JournalSummary };
export type VMClientEvent =
  | { kind: 'delta'; requestId: string; delta: string }
  | { kind: 'terminated'; reason: string };

type WorkerFactory = () => Worker;
type VMRequestBody =
  | { kind: 'VM_INIT'; session: WorkspaceSession }
  | { kind: 'VM_ATTACH_WORKSPACE'; handle: FileSystemDirectoryHandle }
  | { kind: 'VM_EXEC'; command: string; timeoutMs: number }
  | { kind: 'VM_BEGIN_TRANSACTION'; transactionId: string }
  | { kind: 'VM_COMMIT_TRANSACTION' }
  | { kind: 'VM_ROLLBACK_TRANSACTION' }
  | { kind: 'VM_CANCEL'; targetRequestId: string };

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('../worker/vm.worker.ts', import.meta.url), { type: 'module' });

const error = (code: string): Error => new Error(code);

/** Request-correlated client for the Dedicated Worker. Directory handles never leave this client/Worker boundary. */
export class VMClient {
  private worker: Worker | null = null;
  private clonedWorkspace: FileSystemDirectoryHandle | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly subscribers = new Set<(event: VMClientEvent) => void>();
  private readonly watchdog = new VMWatchdog((reason) => this.terminate(reason));
  private readonly executionWatches = new Map<string, WatchdogRun>();
  private workerGeneration = 0;
  private terminated = false;

  constructor(private readonly createWorker: WorkerFactory = defaultWorkerFactory) {}

  subscribe(listener: (event: VMClientEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  start(session: WorkspaceSession): Promise<void> {
    return this.request<void>({ kind: 'VM_INIT', session }, 'ready');
  }

  attachWorkspace(handle: FileSystemDirectoryHandle): Promise<void> {
    this.clonedWorkspace = handle;
    return this.request<void>({ kind: 'VM_ATTACH_WORKSPACE', handle }, 'ready');
  }

  exec(command: string, { timeoutMs }: { timeoutMs: number }): Promise<VMExecutionResult> {
    if (this.executionWatches.size) return Promise.reject(error('VM_EXEC_BUSY'));
    return this.request<VMExecutionResult>({ kind: 'VM_EXEC', command, timeoutMs }, 'result', (worker, requestId) => {
      this.executionWatches.set(requestId, this.watchdog.run(worker, { timeoutMs, maxStreamBytes: 8_388_608, heartbeatTimeoutMs: 5_000 }));
    });
  }

  /** Native termination is authoritative; the worker-side cancel remains idempotent for direct clients. */
  cancel(requestId: string): void { this.executionWatches.get(requestId)?.cancel(); }

  disconnect(): void { for (const watch of this.executionWatches.values()) watch.disconnect(); this.terminate('VM_PORT_DISCONNECTED'); }

  beginTransaction(transactionId: string): Promise<void> {
    return this.request<void>({ kind: 'VM_BEGIN_TRANSACTION', transactionId }, 'ready');
  }

  commitTransaction(): Promise<void> {
    return this.request<void>({ kind: 'VM_COMMIT_TRANSACTION' }, 'ready');
  }

  rollbackTransaction(): Promise<void> {
    return this.request<void>({ kind: 'VM_ROLLBACK_TRANSACTION' }, 'ready');
  }

  terminate(reason: string): void {
    const worker = this.worker;
    if (this.terminated && worker === null) return;
    this.terminated = true;
    this.worker = null;
    this.clonedWorkspace = null;
    for (const watch of this.executionWatches.values()) watch.complete();
    this.executionWatches.clear();
    for (const [, deferred] of this.pending) deferred.reject(error(reason));
    this.pending.clear();
    worker?.terminate();
    this.emit({ kind: 'terminated', reason });
  }

  dispose(): void {
    this.terminate('VM_CLIENT_DISPOSED');
    this.subscribers.clear();
  }

  private request<T extends void | VMExecutionResult>(
    body: VMRequestBody,
    expected: 'ready' | 'result',
    afterPost?: (worker: Worker, requestId: string) => void,
  ): Promise<T> {
    const worker = this.ensureWorker();
    const requestId = createRequestId();
    if (this.pending.has(requestId)) return Promise.reject(error('VM_DUPLICATE_REQUEST_ID'));
    const message = { ...body, requestId } as VMRequest;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as Deferred<void | VMExecutionResult>['resolve'], reject });
      try {
        worker.postMessage(message);
        afterPost?.(worker, requestId);
      } catch {
        if (body.kind === 'VM_ATTACH_WORKSPACE') {
          this.terminate('VM_WORKER_UNAVAILABLE');
        } else {
          this.pending.delete(requestId);
          reject(error('VM_WORKER_UNAVAILABLE'));
        }
      }
      void expected;
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.terminated = false;
    const worker = this.createWorker();
    const generation = ++this.workerGeneration;
    this.worker = worker;
    worker.onmessage = (event) => { if (generation === this.workerGeneration && worker === this.worker) this.handleEvent(event.data); };
    worker.onerror = () => { if (generation === this.workerGeneration && worker === this.worker) this.terminate('VM_WORKER_CRASHED'); };
    worker.onmessageerror = () => { if (generation === this.workerGeneration && worker === this.worker) this.terminate('VM_WORKER_CRASHED'); };
    return worker;
  }

  private handleEvent(value: unknown): void {
    if (!isVMEvent(value)) return;
    if (value.kind === 'VM_OUTPUT_DELTA') {
      this.executionWatches.get(value.requestId)?.output(new TextEncoder().encode(value.delta).byteLength);
      if (!this.worker) return;
      this.emit({ kind: 'delta', requestId: value.requestId, delta: value.delta });
      return;
    }
    if (value.kind === 'VM_HEARTBEAT') { this.executionWatches.get(value.requestId)?.heartbeat(); return; }
    const deferred = this.pending.get(value.requestId);
    if (!deferred) return;
    if (value.kind === 'VM_READY') {
      this.pending.delete(value.requestId);
      deferred.resolve();
    } else if (value.kind === 'VM_RESULT') {
      this.pending.delete(value.requestId);
      this.executionWatches.get(value.requestId)?.complete();
      this.executionWatches.delete(value.requestId);
      deferred.resolve({ output: value.output, exitCode: value.exitCode, truncated: value.truncated, durationMs: value.durationMs, transactionId: value.transactionId, journalSummary: value.journalSummary });
    } else {
      this.pending.delete(value.requestId);
      this.executionWatches.get(value.requestId)?.complete();
      this.executionWatches.delete(value.requestId);
      deferred.reject(error(value.code));
    }
  }

  private emit(event: VMClientEvent): void {
    for (const listener of this.subscribers) listener(event);
  }
}
