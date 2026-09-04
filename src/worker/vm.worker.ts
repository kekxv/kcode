import { WorkspaceSessionAuthorizer } from '../security/capabilities';
import { isAuthorizedVMRequest, isVMRequest, type VMEvent } from '../types/protocol';
import { V86Runtime } from './v86-runtime';

const authorizer = new WorkspaceSessionAuthorizer();
let runtime: V86Runtime | null = null;
let serialRequestId: string | null = null;
let lifecycleGeneration = 0;

const send = (event: VMEvent): void => self.postMessage(event);
const fail = (requestId: string, code: string, message: string): void =>
  send({ kind: 'VM_ERROR', requestId, code, message });
const clearRuntime = (): void => {
  runtime?.destroy();
  runtime = null;
  serialRequestId = null;
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
      // The snapshot topology is valid only while networking remains offline.
      await runtime.boot({ useSnapshot: session.network.mode === 'offline' });
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
      await runtime?.attachWorkspace(value.handle);
      if (!isCurrent(generation)) return;
      if (!runtime) throw new Error('VM_RUNTIME_NOT_READY');
      send({ kind: 'VM_READY', requestId });
    } catch {
      fail(requestId, 'VM_ATTACH_FAILED', 'The workspace could not be attached.');
    }
    return;
  }
  if (value.kind === 'VM_CANCEL') {
    invalidateRuntime();
    fail(requestId, 'VM_CANCELLED', 'The VM command was cancelled.');
    self.close();
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
    runtime.serialSend(`${value.command}\n`);
  } catch {
    fail(requestId, 'VM_SERIAL_SEND_FAILED', 'The Linux runtime rejected serial input.');
  }
}
