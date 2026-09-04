/**
 * Task 4 bundle-safe worker boundary. Task 5 replaces this fail-closed shell
 * with the v86 runtime; until then no directory operation or command can run.
 */
self.onmessage = (event: MessageEvent<{ requestId?: string }>) => {
  const requestId = event.data?.requestId;
  if (typeof requestId !== 'string') return;
  self.postMessage({ kind: 'VM_ERROR', requestId, code: 'VM_RUNTIME_UNAVAILABLE', message: 'The Linux runtime is not installed yet.' });
};
