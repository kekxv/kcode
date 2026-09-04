import { afterEach, describe, expect, it, vi } from 'vitest';

type SerialListener = (delta: string) => void;

class FakeRuntime {
  static instances: FakeRuntime[] = [];
  readonly listeners = new Set<SerialListener>();
  private resolveBoot!: () => void;
  private rejectBoot!: (error: Error) => void;
  destroyed = false;
  readonly sent: string[] = [];
  bootConfig: unknown;
  transaction: { transactionId: string; capabilities: readonly string[] } | null = null;
  workspaceBinding: string | null = null;

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

  async attachWorkspace(_handle: FileSystemDirectoryHandle, workspaceBinding: string): Promise<void> { this.workspaceBinding = workspaceBinding; }
  beginTransaction(transactionId: string, capabilities: readonly string[]): void { this.transaction = { transactionId, capabilities }; }
  async commitTransaction(): Promise<void> { this.transaction = null; }
  async rollbackTransaction(): Promise<void> { this.transaction = null; }
  serialSend(command: string): void { this.sent.push(command); }

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
  vi.resetModules();
  FakeRuntime.instances = [];
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
    expect(FakeRuntime.instances[0].sent).toEqual(['cd /work && pwd\n']);
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
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'VM_OUTPUT_DELTA', requestId: 'new', delta: 'KCODE_AFTER_READY' });
    expect(close).not.toHaveBeenCalled();
  });

  it('derives a transaction policy from the immutable approved session, never the request', async () => {
    // Break caught: a VM message that carries write capabilities can turn a read-only workspace into a guest-writeable one.
    class TestDirectoryHandle {}
    const postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage, close: vi.fn(), onmessage: null });
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
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
});
