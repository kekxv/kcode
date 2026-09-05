import { WorkspaceSessionAuthorizer } from '../security/capabilities';
import { isAuthorizedVMRequest, isVMRequest, normalizeMemoryProfile, type VMEvent } from '../types/protocol';
import { WorkspaceStore } from '../utils/idb-store';
import { V86Runtime } from './v86-runtime';
import { ExecController } from './exec-controller';

const authorizer = new WorkspaceSessionAuthorizer();
const workspaceStore = new WorkspaceStore();
let runtime: V86Runtime | null = null;
let lifecycleGeneration = 0;
let workspaceAttached = false;
let activeTransactionId: string | null = null;
let execution: { requestId: string; controller: ExecController; heartbeat: ReturnType<typeof setInterval> } | null = null;
let outputLimit: (() => void) | null = null;
let emulatorDisposed = false;
let initialized = false;

const send = (event: VMEvent): void => self.postMessage(event);
const fail = (requestId: string, code: string, message: string): void =>
  send({ kind: 'VM_ERROR', requestId, code, message });
const clearRuntime = (): void => {
  runtime?.destroy();
  runtime = null;
  if (execution) clearInterval(execution.heartbeat);
  execution = null;
  outputLimit = null;
  emulatorDisposed = false;
  workspaceAttached = false;
  activeTransactionId = null;
  authorizer.clear();
};
const invalidateRuntime = (): number => {
  lifecycleGeneration += 1;
  clearRuntime();
  return lifecycleGeneration;
};
const isCurrent = (generation: number): boolean => generation === lifecycleGeneration;
const isCurrentRuntime = (generation: number, candidate: V86Runtime): boolean =>
  isCurrent(generation) && runtime === candidate;

self.onmessage = (event: MessageEvent<unknown>) => {
  void dispatch(event.data);
};

async function dispatch(value: unknown): Promise<void> {
  if (!isVMRequest(value)) {
    if (isCorrelatedInit(value)) {
      const memoryProfile = 'memoryProfile' in value ? normalizeMemoryProfile(value.memoryProfile) : 'standard';
      fail(
        value.requestId,
        memoryProfile === null ? 'VM_MEMORY_PROFILE_INVALID' : 'VM_INIT_INVALID',
        memoryProfile === null ? 'The requested VM memory profile is invalid.' : 'The VM initialization request is invalid.',
      );
      self.close();
    }
    return;
  }
  const { requestId } = value;
  if (value.kind === 'VM_INIT') {
    if (initialized) {
      invalidateRuntime();
      fail(requestId, 'VM_REINITIALIZATION_FORBIDDEN', 'A new VM session requires a new Dedicated Worker.');
      self.close();
      return;
    }
    initialized = true;
    const generation = invalidateRuntime();
    try {
      const memoryProfile = normalizeMemoryProfile(value.memoryProfile);
      if (!memoryProfile) throw new Error('VM_MEMORY_PROFILE_INVALID');
      const session = authorizer.activate(value.session);
      runtime = new V86Runtime({
        onOutputLimit: () => outputLimit?.(),
      });
      // A snapshot is captured before any selected directory exists. Workspace
      // sessions cold-boot so their 9P device and serial shell are live before
      // a directory handle can be attached.
      await runtime.boot({ useSnapshot: false, memoryProfile, network: session.network });
      if (!isCurrent(generation)) return;
      send({ kind: 'VM_READY', requestId });
    } catch {
      if (!isCurrent(generation)) return;
      invalidateRuntime();
      fail(requestId, 'VM_BOOT_FAILED', 'The verified Linux runtime could not boot.');
    }
    return;
  }

  // Directory authority is admitted only after the authorizer accepted VM_INIT.
  if (!isAuthorizedVMRequest(value, authorizer)) {
    fail(requestId, 'VM_UNAUTHORIZED_REQUEST', 'The VM request is not authorized for this session.');
    return;
  }
  if (value.kind === 'VM_ATTACH_WORKSPACE') {
    const generation = lifecycleGeneration;
    const attachRuntime = runtime;
    try {
      if (!attachRuntime) throw new Error('VM_RUNTIME_NOT_READY');
      const workspaceBinding = authorizer.workspaceBinding();
      if (!workspaceBinding) throw new Error('VM_UNAUTHORIZED_REQUEST');
      await workspaceStore.verifyHandleBinding(workspaceBinding, value.handle);
      if (!isCurrentRuntime(generation, attachRuntime)) return;
      await attachRuntime.attachWorkspace(value.handle, workspaceBinding);
      if (!isCurrentRuntime(generation, attachRuntime)) return;
      workspaceAttached = true;
      send({ kind: 'VM_READY', requestId });
    } catch (error) {
      if (attachRuntime && !isCurrentRuntime(generation, attachRuntime)) return;
      if (error instanceof Error && error.message === 'WORKSPACE_CONFLICT') {
        fail(requestId, 'WORKSPACE_CONFLICT', 'An unfinished workspace mutation requires recovery.');
      } else {
        fail(requestId, 'VM_ATTACH_FAILED', 'The workspace could not be attached.');
      }
    }
    return;
  }
  if (value.kind === 'VM_CANCEL') {
    const current = execution;
    if (current?.requestId === value.targetRequestId) current.controller.cancel();
    // Unknown IDs are intentionally successful and must not be able to
    // destroy a later execution by request-id guessing.
    send({ kind: 'VM_READY', requestId });
    return;
  }
  if (value.kind === 'VM_BEGIN_TRANSACTION' || value.kind === 'VM_COMMIT_TRANSACTION' || value.kind === 'VM_ROLLBACK_TRANSACTION') {
    if (execution) {
      fail(requestId, 'VM_EXEC_ACTIVE', 'The transaction is frozen until the disposable execution ends.');
      return;
    }
    if (!runtime || !workspaceAttached) {
      fail(requestId, 'VM_RUNTIME_NOT_READY', 'The workspace must be attached before a transaction can start.');
      return;
    }
    try {
      if (value.kind === 'VM_BEGIN_TRANSACTION') {
        if (emulatorDisposed || activeTransactionId !== null) throw new Error('VM_TRANSACTION_STATE');
        const capabilities = authorizer.transactionCapabilities();
        if (!capabilities) throw new Error('VM_UNAUTHORIZED_REQUEST');
        runtime.beginTransaction(value.transactionId, capabilities);
        activeTransactionId = value.transactionId;
      } else if (value.kind === 'VM_COMMIT_TRANSACTION') {
        if (!emulatorDisposed || activeTransactionId === null) throw new Error('VM_TRANSACTION_STATE');
        await runtime.commitTransaction();
        activeTransactionId = null;
      } else {
        if (!emulatorDisposed || activeTransactionId === null) throw new Error('VM_TRANSACTION_STATE');
        await runtime.rollbackTransaction();
        activeTransactionId = null;
      }
      send({ kind: 'VM_READY', requestId });
      if ((value.kind === 'VM_COMMIT_TRANSACTION' || value.kind === 'VM_ROLLBACK_TRANSACTION') && !execution) {
        clearRuntime();
        self.close();
      }
    } catch {
      fail(requestId, 'VM_TRANSACTION_FAILED', 'The workspace transaction could not be completed.');
    }
    return;
  }
  if (!runtime || !workspaceAttached || execution || emulatorDisposed) {
    fail(requestId, 'VM_RUNTIME_NOT_READY', 'The Linux runtime is not ready.');
    return;
  }
  if (value.kind === 'VM_READ_FILE' || value.kind === 'VM_WRITE_FILE') {
    const operationRuntime = runtime;
    const generation = lifecycleGeneration;
    const transactionId = activeTransactionId ?? 'no_transaction';
    const startedAt = performance.now();
    try {
      const result = value.kind === 'VM_READ_FILE'
        ? await operationRuntime.readFile(value.path, value.maxBytes)
        : await operationRuntime.writeFile(value.path, value.content);
      if (!isCurrentRuntime(generation, operationRuntime)) return;
      emulatorDisposed = true;
      send({
        kind: 'VM_FILE_RESULT', requestId, ...result,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        transactionId,
        journalSummary: operationRuntime.journalSummary(transactionId),
      });
      if (transactionId === 'no_transaction') { clearRuntime(); self.close(); }
    } catch (error) {
      if (!isCurrentRuntime(generation, operationRuntime)) return;
      emulatorDisposed = true;
      fail(requestId, error instanceof Error ? error.message : 'VM_FILE_OPERATION_FAILED', 'The confined workspace file operation failed.');
      if (transactionId === 'no_transaction') { clearRuntime(); self.close(); }
    }
    return;
  }
  const executionRuntime = runtime;
  executionRuntime.resetCommandSerialBudget();
  const controller = new ExecController(executionRuntime, {
    onOutput: (delta) => {
      if (isCurrentRuntime(lifecycleGeneration, executionRuntime) && execution?.requestId === requestId) {
        send({ kind: 'VM_OUTPUT_DELTA', requestId, delta });
      }
    },
    journalSummary: (transactionId) => executionRuntime.journalSummary(transactionId),
  });
  const heartbeat = setInterval(() => {
    if (isCurrentRuntime(lifecycleGeneration, executionRuntime) && execution?.requestId === requestId) send({ kind: 'VM_HEARTBEAT', requestId });
  }, 1_000);
  execution = { requestId, controller, heartbeat };
  outputLimit = () => controller.outputLimit();
  const generation = lifecycleGeneration;
  const transactionId = activeTransactionId ?? 'no_transaction';
  void controller.exec(value.command, value.timeoutMs, transactionId).then((result) => {
    if (!isCurrentRuntime(generation, executionRuntime) || execution?.requestId !== requestId) return;
    clearInterval(heartbeat);
    execution = null;
    outputLimit = null;
    emulatorDisposed = true;
    send({ kind: 'VM_RESULT', requestId, ...result });
    if (transactionId === 'no_transaction') {
      clearRuntime();
      self.close();
    }
  }).catch((error: unknown) => {
    if (!isCurrentRuntime(generation, executionRuntime) || execution?.requestId !== requestId) return;
    clearInterval(heartbeat);
    execution = null;
    outputLimit = null;
    emulatorDisposed = true;
    const code = error instanceof Error ? error.message : 'VM_EXEC_FAILED';
    fail(requestId, code, 'The disposable Linux execution ended without a result.');
    if (transactionId === 'no_transaction') {
      clearRuntime();
      self.close();
    }
  });
}

function isCorrelatedInit(value: unknown): value is Record<string, unknown> & { kind: 'VM_INIT'; requestId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'VM_INIT'
    && typeof candidate.requestId === 'string'
    && /^[A-Za-z0-9_-]{1,64}$/.test(candidate.requestId);
}
