import { WorkspaceSessionAuthorizer } from '../security/capabilities';
import { isAuthorizedVMRequest, isVMRequest, type VMEvent } from '../types/protocol';
import { V86Runtime } from './v86-runtime';

const authorizer = new WorkspaceSessionAuthorizer();
let runtime: V86Runtime | null = null;
let activeRequestId: string | null = null;

const send = (event: VMEvent): void => self.postMessage(event);
const fail = (requestId: string, code: string, message: string): void =>
  send({ kind: 'VM_ERROR', requestId, code, message });
const destroyRuntime = (): void => {
  runtime?.destroy();
  runtime = null;
  activeRequestId = null;
  authorizer.clear();
};

self.onmessage = (event: MessageEvent<unknown>) => {
  void dispatch(event.data);
};

async function dispatch(value: unknown): Promise<void> {
  if (!isVMRequest(value)) return;
  const { requestId } = value;
  if (value.kind === 'VM_INIT') {
    destroyRuntime();
    try {
      const session = authorizer.activate(value.session);
      runtime = new V86Runtime({
        onOutputLimit: () => {
          const outputRequestId = activeRequestId;
          if (outputRequestId) fail(outputRequestId, 'VM_OUTPUT_LIMIT', 'VM serial output exceeded 8 MiB.');
          destroyRuntime();
          self.close();
        },
      });
      // The snapshot topology is valid only while networking remains offline.
      await runtime.boot({ useSnapshot: session.network.mode === 'offline' });
      send({ kind: 'VM_READY', requestId });
    } catch {
      destroyRuntime();
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
    try {
      await runtime?.attachWorkspace(value.handle);
      if (!runtime) throw new Error('VM_RUNTIME_NOT_READY');
      send({ kind: 'VM_READY', requestId });
    } catch {
      fail(requestId, 'VM_ATTACH_FAILED', 'The workspace could not be attached.');
    }
    return;
  }
  if (value.kind === 'VM_CANCEL') {
    destroyRuntime();
    fail(requestId, 'VM_CANCELLED', 'The VM command was cancelled.');
    self.close();
    return;
  }
  activeRequestId = requestId;
  // Command framing arrives in Task 8. Never retain a live guest between calls.
  destroyRuntime();
  fail(requestId, 'VM_EXEC_UNAVAILABLE', 'Shell execution is not installed yet.');
  self.close();
}
