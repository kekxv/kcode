import { createRequestId, isVMEvent, normalizeMemoryProfile, type MemoryProfile, type VMEvent, type VMRequest, type WorkspaceSession } from '../types/protocol';
import { VMWatchdog, type WatchdogRun } from './vm-watchdog';
import type { JournalSummary } from '../worker/p9/mutation-journal';

type Deferred<T> = { resolve: (value: T) => void; reject: (reason: Error) => void };
type Pending = Deferred<void | VMExecutionResult | VMFileResult> & { timer?: ReturnType<typeof setTimeout>; retireOnReady?: boolean; retireOnTerminal?: boolean };

export type VMExecutionResult = { output: string; exitCode: number; truncated: boolean; durationMs: number; transactionId: string; journalSummary: JournalSummary };
export type VMFileResult = { text: string; truncated: boolean; durationMs: number; transactionId: string; journalSummary: JournalSummary };
export type VMClientEvent =
  | { kind: 'delta'; requestId: string; delta: string }
  | { kind: 'terminated'; reason: string };

type WorkerFactory = () => Worker;
type VMRequestBody =
  | { kind: 'VM_INIT'; session: WorkspaceSession; memoryProfile: MemoryProfile; persistent?: boolean }
  | { kind: 'VM_UPDATE_SESSION'; session: WorkspaceSession }
  | { kind: 'VM_ATTACH_WORKSPACE'; handle: FileSystemDirectoryHandle }
  | { kind: 'VM_STDIN'; targetRequestId: string; data: string }
  | { kind: 'VM_EXEC'; command: string; timeoutMs: number }
  | { kind: 'VM_READ_FILE'; path: string; maxBytes: number }
  | { kind: 'VM_WRITE_FILE'; path: string; content: string }
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
  private activeTransactionId: string | null = null;
  private selectedMemoryProfile: MemoryProfile = 'standard';
  private activeMemoryProfile: MemoryProfile | null = null;
  private terminated = false;
  private persistent = false;
  private session: WorkspaceSession | null = null;

  constructor(private readonly createWorker: WorkerFactory = defaultWorkerFactory) {}

  subscribe(listener: (event: VMClientEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  selectMemoryProfile(requestedProfile: MemoryProfile): void {
    const memoryProfile = normalizeMemoryProfile(requestedProfile);
    if (!memoryProfile) throw error('VM_MEMORY_PROFILE_INVALID');
    if (memoryProfile === this.selectedMemoryProfile) return;
    this.terminate('VM_MEMORY_PROFILE_CHANGED');
    this.selectedMemoryProfile = memoryProfile;
  }

  start(session: WorkspaceSession, requestedProfile: MemoryProfile = this.selectedMemoryProfile, persistent = false): Promise<void> {
    const memoryProfile = normalizeMemoryProfile(requestedProfile);
    if (!memoryProfile) return Promise.reject(error('VM_MEMORY_PROFILE_INVALID'));
    if (persistent && this.persistent && this.worker && this.session?.workspaceId === session.workspaceId
      && JSON.stringify(this.session.network) === JSON.stringify(session.network) && this.activeMemoryProfile === memoryProfile) {
      if (this.pending.size || this.activeTransactionId) return Promise.reject(error('VM_EXEC_BUSY'));
      return this.request<void>({ kind: 'VM_UPDATE_SESSION', session }, 'ready').then(() => { this.session = session; });
    }
    if (this.activeMemoryProfile !== null) {
      this.terminate(this.activeMemoryProfile === memoryProfile ? 'VM_SESSION_RESTARTED' : 'VM_MEMORY_PROFILE_CHANGED');
    }
    this.selectedMemoryProfile = memoryProfile;
    this.activeMemoryProfile = memoryProfile;
    this.persistent = persistent;
    this.session = session;
    return this.request<void>({ kind: 'VM_INIT', session, memoryProfile, ...(persistent ? { persistent } : {}) }, 'ready');
  }

  attachWorkspace(handle: FileSystemDirectoryHandle): Promise<void> {
    if (this.persistent && this.clonedWorkspace === handle) return Promise.resolve();
    return this.request<void>({ kind: 'VM_ATTACH_WORKSPACE', handle }, 'ready').then(() => { this.clonedWorkspace = handle; });
  }

  exec(command: string, { timeoutMs }: { timeoutMs: number }): Promise<VMExecutionResult> {
    if (this.executionWatches.size) return Promise.reject(error('VM_EXEC_BUSY'));
    return this.request<VMExecutionResult>({ kind: 'VM_EXEC', command, timeoutMs }, 'result', (worker, requestId) => {
      this.executionWatches.set(requestId, this.watchdog.run(worker, { timeoutMs, maxStreamBytes: 8_388_608, heartbeatTimeoutMs: 5_000 }));
    }, false, !this.persistent && this.activeTransactionId === null);
  }

  sendInput(data: string): Promise<void> {
    if (new TextEncoder().encode(data).byteLength > 8192) return Promise.reject(error('VM_STDIN_TOO_LARGE'));
    const targetRequestId = this.executionWatches.keys().next().value;
    if (!targetRequestId || !this.persistent) return Promise.reject(error('VM_STDIN_NOT_READY'));
    return this.request<void>({ kind: 'VM_STDIN', targetRequestId, data }, 'ready');
  }

  readFile(path: string, maxBytes = 1_048_576): Promise<VMFileResult> {
    return this.request<VMFileResult>({ kind: 'VM_READ_FILE', path, maxBytes }, 'file', undefined, false, !this.persistent && this.activeTransactionId === null);
  }

  writeFile(path: string, content: string): Promise<VMFileResult> {
    return this.request<VMFileResult>({ kind: 'VM_WRITE_FILE', path, content }, 'file', undefined, false, !this.persistent && this.activeTransactionId === null);
  }

  /** Native termination is authoritative; the worker-side cancel remains idempotent for direct clients. */
  cancel(requestId: string): void { this.executionWatches.get(requestId)?.cancel(); }

  disconnect(): void { for (const watch of this.executionWatches.values()) watch.disconnect(); this.terminate('VM_PORT_DISCONNECTED'); }

  beginTransaction(transactionId: string): Promise<void> {
    return this.request<void>({ kind: 'VM_BEGIN_TRANSACTION', transactionId }, 'ready').then(() => { this.activeTransactionId = transactionId; });
  }

  commitTransaction(): Promise<void> {
    return this.request<void>({ kind: 'VM_COMMIT_TRANSACTION' }, 'ready', undefined, !this.persistent).then(() => { this.activeTransactionId = null; });
  }

  rollbackTransaction(): Promise<void> {
    return this.request<void>({ kind: 'VM_ROLLBACK_TRANSACTION' }, 'ready', undefined, !this.persistent).then(() => { this.activeTransactionId = null; });
  }

  terminate(reason: string): void {
    const worker = this.worker;
    if (this.terminated && worker === null) return;
    this.terminated = true;
    this.worker = null;
    this.clonedWorkspace = null;
    this.activeTransactionId = null;
    this.activeMemoryProfile = null;
    this.session = null; this.persistent = false;
    for (const watch of this.executionWatches.values()) watch.complete();
    this.executionWatches.clear();
    for (const [, deferred] of this.pending) { clearTimeout(deferred.timer); deferred.reject(error(reason)); }
    this.pending.clear();
    worker?.terminate();
    this.emit({ kind: 'terminated', reason });
  }

  dispose(): void {
    this.terminate('VM_CLIENT_DISPOSED');
    this.subscribers.clear();
  }

  private request<T extends void | VMExecutionResult | VMFileResult>(
    body: VMRequestBody,
    expected: 'ready' | 'result' | 'file',
    afterPost?: (worker: Worker, requestId: string) => void,
    retireOnReady = false,
    retireOnTerminal = false,
  ): Promise<T> {
    const worker = this.ensureWorker();
    const requestId = createRequestId();
    if (this.pending.has(requestId)) return Promise.reject(error('VM_DUPLICATE_REQUEST_ID'));
    const message = { ...body, requestId } as VMRequest;
    return new Promise<T>((resolve, reject) => {
      const timer = body.kind === 'VM_EXEC' ? undefined : setTimeout(() => this.terminate('VM_REQUEST_TIMEOUT'), 60_000);
      this.pending.set(requestId, { timer, resolve: resolve as Deferred<void | VMExecutionResult | VMFileResult>['resolve'], reject, retireOnReady, retireOnTerminal });
      try {
        worker.postMessage(message);
        afterPost?.(worker, requestId);
      } catch {
        if (body.kind === 'VM_ATTACH_WORKSPACE') {
          this.terminate('VM_WORKER_UNAVAILABLE');
        } else {
          clearTimeout(this.pending.get(requestId)?.timer);
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

  /** `self.close()` has no Dedicated Worker close event, so terminal paths retire it natively and invalidate its generation. */
  private retireWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.clonedWorkspace = null;
    this.activeMemoryProfile = null;
    this.workerGeneration += 1;
    worker.terminate();
  }

  private handleEvent(value: unknown): void {
    if (!isVMEvent(value)) {
      if (value && typeof value === 'object' && 'requestId' in value && typeof value.requestId === 'string' && this.pending.has(value.requestId)) this.terminate('VM_PROTOCOL_ERROR');
      return;
    }
    if (value.kind === 'VM_OUTPUT_DELTA') {
      this.executionWatches.get(value.requestId)?.output(new TextEncoder().encode(value.delta).byteLength);
      if (!this.worker) return;
      this.emit({ kind: 'delta', requestId: value.requestId, delta: value.delta });
      return;
    }
    if (value.kind === 'VM_HEARTBEAT') { this.executionWatches.get(value.requestId)?.heartbeat(); return; }
    const deferred = this.pending.get(value.requestId);
    if (!deferred) return;
    clearTimeout(deferred.timer);
    if (value.kind === 'VM_READY') {
      this.pending.delete(value.requestId);
      if (deferred.retireOnReady) this.retireWorker();
      deferred.resolve();
    } else if (value.kind === 'VM_RESULT') {
      this.pending.delete(value.requestId);
      this.executionWatches.get(value.requestId)?.complete();
      this.executionWatches.delete(value.requestId);
      if (deferred.retireOnTerminal || (!this.persistent && value.transactionId === 'no_transaction')) this.retireWorker();
      deferred.resolve({ output: value.output, exitCode: value.exitCode, truncated: value.truncated, durationMs: value.durationMs, transactionId: value.transactionId, journalSummary: value.journalSummary });
    } else if (value.kind === 'VM_FILE_RESULT') {
      this.pending.delete(value.requestId);
      if (deferred.retireOnTerminal || (!this.persistent && value.transactionId === 'no_transaction')) this.retireWorker();
      deferred.resolve({ text: value.text, truncated: value.truncated, durationMs: value.durationMs, transactionId: value.transactionId, journalSummary: value.journalSummary });
    } else {
      this.pending.delete(value.requestId);
      this.executionWatches.get(value.requestId)?.complete();
      this.executionWatches.delete(value.requestId);
      if (deferred.retireOnTerminal) this.retireWorker();
      deferred.reject(error(value.code));
      if (this.persistent && /^(VM_BOOT_FAILED|VM_SESSION_UPDATE_FORBIDDEN|VM_RUNTIME_NOT_READY|VM_TIMEOUT|VM_CANCELLED|VM_OUTPUT_LIMIT|VM_SERIAL_SEND_FAILED)$/.test(value.code)) this.terminate(value.code);
    }
  }

  private emit(event: VMClientEvent): void {
    for (const listener of this.subscribers) listener(event);
  }
}
