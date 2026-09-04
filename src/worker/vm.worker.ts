import { WorkspaceSessionAuthorizer } from '../security/capabilities';
import { isAuthorizedVMRequest, isVMRequest, type VMEvent } from '../types/protocol';
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
  if (!isVMRequest(value)) return;
  const { requestId } = value;
  if (value.kind === 'VM_INIT') {
    const generation = invalidateRuntime();
    try {
      const session = authorizer.activate(value.session);
      runtime = new V86Runtime({
        onOutputLimit: () => outputLimit?.(),
      });
      // A snapshot is captured before any selected directory exists. Workspace
      // sessions cold-boot so their 9P device and serial shell are live before
      // a directory handle can be attached.
      await runtime.boot({ useSnapshot: false });
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
    if (!runtime || !workspaceAttached) {
      fail(requestId, 'VM_RUNTIME_NOT_READY', 'The workspace must be attached before a transaction can start.');
      return;
    }
    try {
      if (value.kind === 'VM_BEGIN_TRANSACTION') {
        const capabilities = authorizer.transactionCapabilities();
        if (!capabilities) throw new Error('VM_UNAUTHORIZED_REQUEST');
        runtime.beginTransaction(value.transactionId, capabilities);
        activeTransactionId = value.transactionId;
      } else if (value.kind === 'VM_COMMIT_TRANSACTION') {
        await runtime.commitTransaction();
        activeTransactionId = null;
      } else {
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
  if (!runtime || execution || emulatorDisposed) {
    fail(requestId, 'VM_RUNTIME_NOT_READY', 'The Linux runtime is not ready.');
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
  void controller.exec(value.command, value.timeoutMs, activeTransactionId ?? 'no_transaction').then((result) => {
    if (!isCurrentRuntime(generation, executionRuntime) || execution?.requestId !== requestId) return;
    clearInterval(heartbeat);
    execution = null;
    outputLimit = null;
    emulatorDisposed = true;
    send({ kind: 'VM_RESULT', requestId, ...result });
  }).catch((error: unknown) => {
    if (!isCurrentRuntime(generation, executionRuntime) || execution?.requestId !== requestId) return;
    clearInterval(heartbeat);
    execution = null;
    outputLimit = null;
    emulatorDisposed = true;
    const code = error instanceof Error ? error.message : 'VM_EXEC_FAILED';
    fail(requestId, code, 'The disposable Linux execution ended without a result.');
  });
}
