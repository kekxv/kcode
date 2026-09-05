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
  readonly fileCalls: Array<{ kind: 'read' | 'write'; path: string; value: number | string }> = [];

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
  async readFile(path: string, maxBytes: number) { this.fileCalls.push({ kind: 'read', path, value: maxBytes }); return { text: 'file', truncated: false }; }
  async writeFile(path: string, content: string) { this.fileCalls.push({ kind: 'write', path, value: content }); return { text: '', truncated: false }; }

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
    expect(FakeRuntime.instances[0].bootConfig).toEqual({ useSnapshot: false, memoryProfile: 'standard', network: { mode: 'offline' } });
  });

  it('passes the accepted high-memory profile only to a fresh cold boot', async () => {
    // Break caught: the worker can accidentally normalize high back to standard or request a reusable snapshot before Task 3 binds one to 512 MiB.
    vi.stubGlobal('self', { postMessage: vi.fn(), close: vi.fn(), onmessage: null });
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session, memoryProfile: 'high' } } as MessageEvent);
    expect(FakeRuntime.instances[0].bootConfig).toEqual({ useSnapshot: false, memoryProfile: 'high', network: { mode: 'offline' } });
  });

  it('fails closed and retires a Dedicated Worker that receives a second VM_INIT', async () => {
    // Break caught: reinitializing v86 in one native Worker can carry handles, listeners, or authority across RAM/session generations.
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('self', { postMessage, close, onmessage: null });
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };

    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'first', session } } as MessageEvent);
    FakeRuntime.instances[0].resolve();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'first' }));
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'second', session, memoryProfile: 'high' } } as MessageEvent);

    expect(FakeRuntime.instances).toHaveLength(1);
    expect(FakeRuntime.instances[0].destroyed).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_ERROR', requestId: 'second', code: 'VM_REINITIALIZATION_FORBIDDEN' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns a correlated error for an invalid VM_INIT memory profile', async () => {
    // Break caught: dropping a malformed but correlated startup request leaves the VMClient pending until an unrelated watchdog fires.
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('self', { postMessage, close, onmessage: null });
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };

    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'invalid-profile', session, memoryProfile: 'huge' } } as MessageEvent);

    expect(FakeRuntime.instances).toHaveLength(0);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_ERROR', requestId: 'invalid-profile', code: 'VM_MEMORY_PROFILE_INVALID' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('dispatches every guest command from the exclusive /work mount point', async () => {
    // Break caught: shell commands run from guest root/home can access a different filesystem even while /work is correctly mounted.
    class TestDirectoryHandle {}
    vi.stubGlobal('self', { postMessage: vi.fn(), close: vi.fn(), onmessage: null });
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
    vi.doMock('../../src/utils/idb-store', () => ({ WorkspaceStore: class { async verifyHandleBinding(): Promise<void> {} } }));
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session } } as MessageEvent);
    FakeRuntime.instances[0].resolve(); await Promise.resolve(); await Promise.resolve();
    worker.onmessage?.({ data: { kind: 'VM_ATTACH_WORKSPACE', requestId: 'attach', handle: new TestDirectoryHandle() } } as MessageEvent);
    await Promise.resolve(); await Promise.resolve();
    worker.onmessage?.({ data: { kind: 'VM_EXEC', requestId: 'run', command: 'pwd', timeoutMs: 30_000 } } as MessageEvent);
    expect(FakeRuntime.instances[0].sent).toHaveLength(1);
    expect(FakeRuntime.instances[0].sent[0]).toContain('cd /work && exec /bin/sh');
  });

  it('dispatches confined file RPCs without converting path or content into shell commands', async () => {
    // Break caught: quoting a hostile path/content into a guest command would turn read_file/write_file into shell injection primitives.
    class TestDirectoryHandle {}
    const postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage, close: vi.fn(), onmessage: null });
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
    vi.doMock('../../src/utils/idb-store', () => ({ WorkspaceStore: class { async verifyHandleBinding(): Promise<void> {} } }));
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };
    const writeSession = { mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['write'], network: { mode: 'offline' } } as const;
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session: writeSession } } as MessageEvent);
    const runtime = FakeRuntime.instances[0]; runtime.resolve();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'boot' }));
    worker.onmessage?.({ data: { kind: 'VM_ATTACH_WORKSPACE', requestId: 'attach', handle: new TestDirectoryHandle() } } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'attach' }));
    worker.onmessage?.({ data: { kind: 'VM_BEGIN_TRANSACTION', requestId: 'begin', transactionId: 'tx_file' } } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'begin' }));
    worker.onmessage?.({ data: { kind: 'VM_WRITE_FILE', requestId: 'write', path: "a'b.txt", content: '$(id)' } } as MessageEvent);

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_FILE_RESULT', requestId: 'write', transactionId: 'tx_file' })));
    expect(runtime.fileCalls).toEqual([{ kind: 'write', path: "a'b.txt", value: '$(id)' }]);
    expect(runtime.sent).toEqual([]);
  });

  it('rejects execution before the current authorized workspace is attached', async () => {
    // Break caught: an empty guest /work directory is not the selected FSA directory and must never be used as an execution capability.
    const postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage, close: vi.fn(), onmessage: null });
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session } } as MessageEvent);
    FakeRuntime.instances[0].resolve(); await Promise.resolve(); await Promise.resolve();

    worker.onmessage?.({ data: { kind: 'VM_EXEC', requestId: 'unmounted', command: 'pwd', timeoutMs: 30_000 } } as MessageEvent);

    expect(FakeRuntime.instances[0].sent).toEqual([]);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_ERROR', requestId: 'unmounted', code: 'VM_RUNTIME_NOT_READY' }));
  });

  it('freezes transaction authority while an execution is live', async () => {
    // Break caught: changing the P9 transaction mid-command makes the command result describe a different journal than the one that performed its writes.
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
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'attach' }));
    worker.onmessage?.({ data: { kind: 'VM_EXEC', requestId: 'run', command: 'sleep 1', timeoutMs: 30_000 } } as MessageEvent);

    worker.onmessage?.({ data: { kind: 'VM_BEGIN_TRANSACTION', requestId: 'begin', transactionId: 'tx_1' } } as MessageEvent);
    worker.onmessage?.({ data: { kind: 'VM_COMMIT_TRANSACTION', requestId: 'commit' } } as MessageEvent);
    worker.onmessage?.({ data: { kind: 'VM_ROLLBACK_TRANSACTION', requestId: 'rollback' } } as MessageEvent);

    expect(FakeRuntime.instances[0].transaction).toBeNull();
    for (const requestId of ['begin', 'commit', 'rollback']) {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_ERROR', requestId, code: 'VM_EXEC_ACTIVE' }));
    }
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

  it('closes the Worker immediately after an untransactioned result destroys v86', async () => {
    // Break caught: retaining a no-journal Worker after its disposable VM is gone retains a cloned workspace capability and prevents fresh generations.
    class TestDirectoryHandle {}
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('self', { postMessage, close, onmessage: null });
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
    vi.doMock('../../src/utils/idb-store', () => ({ WorkspaceStore: class { async verifyHandleBinding(): Promise<void> {} } }));
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'boot', session } } as MessageEvent);
    const runtime = FakeRuntime.instances[0]; runtime.resolve(); await Promise.resolve(); await Promise.resolve();
    worker.onmessage?.({ data: { kind: 'VM_ATTACH_WORKSPACE', requestId: 'attach', handle: new TestDirectoryHandle() } } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: 'VM_READY', requestId: 'attach' }));
    worker.onmessage?.({ data: { kind: 'VM_EXEC', requestId: 'run', command: 'pwd', timeoutMs: 30_000 } } as MessageEvent);
    const nonce = runtime.sent[0].match(/KCODE_BEGIN:([^\\]+)\\037/)?.[1];
    runtime.emit(`\x1eKCODE_BEGIN:${nonce}\x1f/work\x1eKCODE_END:${nonce}:0\x1f`);

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_RESULT', requestId: 'run', output: '/work' })));
    expect(close).toHaveBeenCalledOnce();
  });

  it('retires the Worker when a second VM_INIT arrives during the first boot', async () => {
    // Break caught: racing startup requests must not create two v86 generations inside one native Worker.
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('self', { postMessage, close, onmessage: null });
    vi.doMock('../../src/worker/v86-runtime', () => ({ V86Runtime: FakeRuntime }));
    await import('../../src/worker/vm.worker');
    const worker = globalThis.self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null };

    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'old', session } } as MessageEvent);
    worker.onmessage?.({ data: { kind: 'VM_INIT', requestId: 'new', session } } as MessageEvent);
    const [oldRuntime] = FakeRuntime.instances;

    expect(FakeRuntime.instances).toHaveLength(1);
    expect(oldRuntime.destroyed).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'new', kind: 'VM_ERROR', code: 'VM_REINITIALIZATION_FORBIDDEN' }));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 'new', kind: 'VM_READY' }));
    expect(close).toHaveBeenCalledOnce();
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

  it('does not attach a stale handle after a second VM_INIT retires the Worker', async () => {
    // Break caught: an in-flight handle verification must not attach after the Worker has rejected a replacement session.
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
    finishVerification();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VM_ERROR', requestId: 'replacement-boot', code: 'VM_REINITIALIZATION_FORBIDDEN' })));

    expect(FakeRuntime.instances[0].attachedHandles).toEqual([]);
    expect(FakeRuntime.instances).toHaveLength(1);
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
