import { afterEach, describe, expect, it, vi } from 'vitest';

type SerialListener = (delta: string) => void;

class FakeRuntime {
  static instances: FakeRuntime[] = [];
  static attachError: Error | null = null;
  readonly listeners = new Set<SerialListener>();
  private resolveBoot!: () => void;
  private rejectBoot!: (error: Error) => void;
  destroyed = false;
  readonly sent: string[] = [];
  bootConfig: unknown;
  transaction: { transactionId: string; capabilities: readonly string[] } | null = null;
  workspaceBinding: string | null = null;
  readonly attachedHandles: FileSystemDirectoryHandle[] = [];

  constructor(_options: unknown) {
    FakeRuntime.instances.push(this);
  }

  boot(config: unknown): Promise<void> {
    this.bootConfig = config;
    return new Promise<void>((resolve, reject) => {
      this.resolveBoot = resolve;
      this.rejectBoot = reject;
    });
  }

  onSerial(listener: SerialListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async attachWorkspace(handle: FileSystemDirectoryHandle, workspaceBinding: string): Promise<void> { this.attachedHandles.push(handle); this.workspaceBinding = workspaceBinding; if (FakeRuntime.attachError) throw FakeRuntime.attachError; }
  beginTransaction(transactionId: string, capabilities: readonly string[]): void { this.transaction = { transactionId, capabilities }; }
  async commitTransaction(): Promise<void> { this.transaction = null; }
  async rollbackTransaction(): Promise<void> { this.transaction = null; }
  serialSend(command: string): void { this.sent.push(command); }
  resetCommandSerialBudget(): void {}
  journalSummary(transactionId: string) { return { transactionId, state: 'clean' as const, entries: [], journalBytes: 0, writtenBytes: 0 }; }

  destroy(): void {
    this.destroyed = true;
    this.rejectBoot?.(new Error('destroyed'));
  }

  resolve(): void { this.resolveBoot(); }
  emit(delta: string): void { for (const listener of this.listeners) listener(delta); }
}

const session = { mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read'], network: { mode: 'offline' } } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../../src/worker/v86-runtime');
  vi.doUnmock('../../src/utils/idb-store');
  vi.resetModules();
  FakeRuntime.instances = [];
  FakeRuntime.attachError = null;
});

describe('vm.worker lifecycle correlation', () => {
  it('cold-boots workspace sessions so a pre-workspace snapshot cannot retain device state', async () => {
    // Break caught: restoring the no-workspace snapshot before an attach can preserve stale 9P topology and run the mount before a live shell.
    vi.stubGlobal('self', { postMessage: vi.fn(), close: vi.fn(), onmessage: null });
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session } } as MessageEvent);
    expect(FakeRuntime.instances[0].bootConfig).toEqual({ useSnapshot: false });
  });

  it('dispatches every guest command from the exclusive /work mount point', async () => {
    // Break caught: shell commands run from guest root/home can access a different filesystem even while /work is correctly mounted.
    vi.stubGlobal('self', { postMessage: vi.fn(), close: vi.fn(), onmessage: null });
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session } } as MessageEvent);
    FakeRuntime.instances[0].resolve(); await Promise.resolve(); await Promise.resolve();
    worker.onmessage?.({ data: { kind: 'VM_EXEC', requestId: 'run', command: 'pwd', timeoutMs: 30_000 } } as MessageEvent);
    expect(FakeRuntime.instances[0].sent).toHaveLength(1);
    expect(FakeRuntime.instances[0].sent[0]).toContain('cd /work && exec /bin/sh');
  });

  it('permits journal finalization but never a second command after disposal destroys v86', async () => {
    // Break caught: keeping the journal object after a terminal event must not accidentally retain an emulator usable for a second shell process.
    const postMessage = vi.fn();
    const close = vi.fn();
    class TestDirectoryHandle {}
    vi.stubGlobal('self', { postMessage, close, onmessage: null });
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
    vi.doMock('../../src/utils/idb-store', () => ({ WorkspaceStore: class { async verifyHandleBinding(): Promise<void> {} } }));
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };
    const writeSession = { mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read', 'write', 'delete'], network: { mode: 'offline' } } as const;
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session: writeSession } } as MessageEvent);
    const active = FakeRuntime.instances[0];
    active.resolve(); await Promise.resolve(); await Promise.resolve();
    worker.onmessage?.({ data: { kind: 'VM_ATTACH_WORKSPACE', requestId: 'attach', handle: new TestDirectoryHandle() } } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'attach' }));
    worker.onmessage?.({ data: { kind: 'VM_BEGIN_TRANSACTION', requestId: 'begin', transactionId: 'tx_1' } } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'begin' }));
    worker.onmessage?.({ data: { kind: 'VM_EXEC', requestId: 'first', command: 'pwd', timeoutMs: 30_000 } } as MessageEvent);
    const nonce = active.sent[0].match(/KCODE_BEGIN:([^\\]+)\\037/)?.[1];
    active.emit(`\x1eKCODE_BEGIN:${nonce}\x1f\x1eKCODE_END:${nonce}:0\x1f`);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_RESULT', requestId: 'first' })));
    expect(active.destroyed).toBe(true);

    worker.onmessage?.({ data: { kind: 'VM_EXEC', requestId: 'second', command: 'id', timeoutMs: 30_000 } } as MessageEvent);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_ERROR', requestId: 'second', code: 'VM_RUNTIME_NOT_READY' }));

    worker.onmessage?.({ data: { kind: 'VM_COMMIT_TRANSACTION', requestId: 'commit' } } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'commit' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the newest VM session correlated after readiness and ignores a superseded boot', async () => {
    // Break caught: a late failure from an older boot destroys the newer VM or sends serial to the wrong request.
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('self', { postMessage, close, onmessage: null });
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };

    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'old', session } } as MessageEvent);
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'new', session } } as MessageEvent);
    const [oldRuntime, newRuntime] = FakeRuntime.instances;
    newRuntime.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(oldRuntime.destroyed).toBe(true);
    expect(newRuntime.destroyed).toBe(false);
    expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'new' });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 'old', kind: 'VM_ERROR' }));

    newRuntime.emit('KCODE_AFTER_READY');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_OUTPUT_DELTA', requestId: 'new' }));
    expect(close).not.toHaveBeenCalled();
  });

  it('derives a transaction policy from the immutable approved session, never the request', async () => {
    // Break caught: a VM message that carries write capabilities can turn a read-only workspace into a guest-writeable one.
    class TestDirectoryHandle {}
    const postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage, close: vi.fn(), onmessage: null });
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
    vi.doMock('../../src/utils/idb-store', () => ({ WorkspaceStore: class { async verifyHandleBinding(): Promise<void> {} } }));
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };
    const writeSession = { mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read', 'write', 'delete'], network: { mode: 'offline' } } as const;

    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session: writeSession } } as MessageEvent);
    FakeRuntime.instances[0].resolve(); await Promise.resolve(); await Promise.resolve();
    worker.onmessage?.({ data: { kind: 'VM_ATTACH_WORKSPACE', requestId: 'attach', handle: new TestDirectoryHandle() } } as MessageEvent);
    await Promise.resolve(); await Promise.resolve();
    worker.onmessage?.({ data: { kind: 'VM_BEGIN_TRANSACTION', requestId: 'begin', transactionId: 'tx_1' } } as MessageEvent);

    expect(FakeRuntime.instances[0].workspaceBinding).toBe('workspace-1');
    expect(FakeRuntime.instances[0].transaction).toEqual({ transactionId: 'tx_1', capabilities: ['read', 'write', 'delete'] });
    expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'begin' });
  });

  it('rejects a different directory handle even when VM_INIT claims the persisted workspace id', async () => {
    // Break caught: a forged session workspaceId must not let a separately attached directory consume that workspace's recovery journal.
    class TestDirectoryHandle {}
    const selectedHandle = new TestDirectoryHandle();
    const wrongHandle = new TestDirectoryHandle();
    const verifyHandleBinding = vi.fn(async (workspaceId: string, handle: FileSystemDirectoryHandle) => {
      if (workspaceId !== 'workspace-1' || handle !== selectedHandle) throw new Error('WORKSPACE_HANDLE_MISMATCH');
    });
    const postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage, close: vi.fn(), onmessage: null });
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
    vi.doMock('../../src/utils/idb-store', () => ({ WorkspaceStore: class { verifyHandleBinding = verifyHandleBinding; } }));
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };

    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session } } as MessageEvent);
    FakeRuntime.instances[0].resolve();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'boot' }));
    worker.onmessage?.({ data: { kind: 'VM_ATTACH_WORKSPACE', requestId: 'attach', handle: wrongHandle } } as MessageEvent);

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_ERROR', requestId: 'attach', code: 'VM_ATTACH_FAILED' })));
    expect(verifyHandleBinding).toHaveBeenCalledWith('workspace-1', wrongHandle);
    expect(FakeRuntime.instances[0].attachedHandles).toEqual([]);
    expect(postMessage).not.toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'attach' });
  });

  it('does not attach a stale handle to a replacement runtime after identity verification yields', async () => {
    // Break caught: an old attach continuation can read the global runtime after VM_INIT replacement and recover/mount its handle on the new VM.
    class TestDirectoryHandle {}
    let finishVerification!: () => void;
    const verifyHandleBinding = vi.fn(() => new Promise<void>((resolve) => { finishVerification = resolve; }));
    const postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage, close: vi.fn(), onmessage: null });
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
    vi.doMock('../../src/utils/idb-store', () => ({ WorkspaceStore: class { verifyHandleBinding = verifyHandleBinding; } }));
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };

    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'old-boot', session } } as MessageEvent);
    FakeRuntime.instances[0].resolve();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'old-boot' }));
    const staleHandle = new TestDirectoryHandle();
    worker.onmessage?.({ data: { kind: 'VM_ATTACH_WORKSPACE', requestId: 'stale-attach', handle: staleHandle } } as MessageEvent);
    await vi.waitFor(() => expect(verifyHandleBinding).toHaveBeenCalledOnce());

    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'replacement-boot', session } } as MessageEvent);
    const replacementRuntime = FakeRuntime.instances[1];
    finishVerification();
    replacementRuntime.resolve();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'replacement-boot' }));

    expect(FakeRuntime.instances[0].attachedHandles).toEqual([]);
    expect(replacementRuntime.attachedHandles).toEqual([]);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 'stale-attach' }));
  });

  it('surfaces an ambiguous startup journal as a workspace conflict', async () => {
    // Break caught: collapsing recovery conflict into a generic attach error hides that an uncommitted host mutation remains durable.
    class TestDirectoryHandle {}
    const postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage, close: vi.fn(), onmessage: null });
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
    vi.doMock('../../src/utils/idb-store', () => ({ WorkspaceStore: class { async verifyHandleBinding(): Promise<void> {} } }));
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };

    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session } } as MessageEvent);
    FakeRuntime.instances[0].resolve();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'boot' }));
    FakeRuntime.attachError = new Error('WORKSPACE_CONFLICT');
    worker.onmessage?.({ data: { kind: 'VM_ATTACH_WORKSPACE', requestId: 'attach-conflict', handle: new TestDirectoryHandle() } } as MessageEvent);

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_ERROR', requestId: 'attach-conflict', code: 'WORKSPACE_CONFLICT' })));
    expect(postMessage).not.toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'attach-conflict' });
  });
});
