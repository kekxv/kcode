import { WorkspaceSessionAuthorizer } from '../security/capabilities';
import { isAuthorizedVMRequest, isVMRequest, type VMEvent } from '../types/protocol';
import { WorkspaceStore } from '../utils/idb-store';
import { V86Runtime } from './v86-runtime';

const authorizer = new WorkspaceSessionAuthorizer();
const workspaceStore = new WorkspaceStore();
let runtime: V86Runtime | null = null;
let serialRequestId: string | null = null;
let lifecycleGeneration = 0;
let workspaceAttached = false;

const send = (event: VMEvent): void => self.postMessage(event);
const fail = (requestId: string, code: string, message: string): void =>
  send({ kind: 'VM_ERROR', requestId, code, message });
const clearRuntime = (): void => {
  runtime?.destroy();
  runtime = null;
  serialRequestId = null;
  workspaceAttached = false;
  authorizer.clear();
};
const invalidateRuntime = (): number => {
  lifecycleGeneration += 1;
  clearRuntime();
  return lifecycleGeneration;
};
const isCurrent = (generation: number): boolean => generation === lifecycleGeneration;

self.onmessage = (event: MessageEvent<unknown>) => {
  void dispatch(event.data);
};

async function dispatch(value: unknown): Promise<void> {
  if (!isVMRequest(value)) return;
  const { requestId } = value;
  if (value.kind === 'VM_INIT') {
    const generation = invalidateRuntime();
    serialRequestId = requestId;
    try {
      const session = authorizer.activate(value.session);
      runtime = new V86Runtime({
        onOutputLimit: () => {
          if (!isCurrent(generation)) return;
          const outputRequestId = serialRequestId;
          if (outputRequestId) fail(outputRequestId, 'VM_OUTPUT_LIMIT', 'VM serial output exceeded 8 MiB.');
          invalidateRuntime();
          self.close();
        },
      });
      runtime.onSerial((delta) => {
        const requestIdForDelta = serialRequestId;
        if (isCurrent(generation) && requestIdForDelta) send({ kind: 'VM_OUTPUT_DELTA', requestId: requestIdForDelta, delta });
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
    try {
      const workspaceBinding = authorizer.workspaceBinding();
      if (!workspaceBinding) throw new Error('VM_UNAUTHORIZED_REQUEST');
      await workspaceStore.verifyHandleBinding(workspaceBinding, value.handle);
      await runtime?.attachWorkspace(value.handle, workspaceBinding);
      if (!isCurrent(generation)) return;
      if (!runtime) throw new Error('VM_RUNTIME_NOT_READY');
      workspaceAttached = true;
      send({ kind: 'VM_READY', requestId });
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_CONFLICT') {
        fail(requestId, 'WORKSPACE_CONFLICT', 'An unfinished workspace mutation requires recovery.');
      } else {
        fail(requestId, 'VM_ATTACH_FAILED', 'The workspace could not be attached.');
      }
    }
    return;
  }
  if (value.kind === 'VM_CANCEL') {
    invalidateRuntime();
    fail(requestId, 'VM_CANCELLED', 'The VM command was cancelled.');
    self.close();
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
      } else if (value.kind === 'VM_COMMIT_TRANSACTION') {
        await runtime.commitTransaction();
      } else {
        await runtime.rollbackTransaction();
      }
      send({ kind: 'VM_READY', requestId });
    } catch {
      fail(requestId, 'VM_TRANSACTION_FAILED', 'The workspace transaction could not be completed.');
    }
    return;
  }
  if (!runtime) {
    fail(requestId, 'VM_RUNTIME_NOT_READY', 'The Linux runtime is not ready.');
    return;
  }
  // Task 8 adds framed completion/exit status. Until then, serial input remains
  // available so the verified runtime can be smoke-tested through this Worker.
  serialRequestId = requestId;
  try {
    // The selected FSA directory is intentionally the only guest work area.
    runtime.serialSend(`cd /work && ${value.command}\n`);
  } catch {
    fail(requestId, 'VM_SERIAL_SEND_FAILED', 'The Linux runtime rejected serial input.');
  }
}
