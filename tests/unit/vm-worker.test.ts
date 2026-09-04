import { afterEach, describe, expect, it, vi } from 'vitest';

type SerialListener = (delta: string) => void;

class FakeRuntime {
  static instances: FakeRuntime[] = [];
  readonly listeners = new Set<SerialListener>();
  private resolveBoot!: () => void;
  private rejectBoot!: (error: Error) => void;
  destroyed = false;

  constructor(_options: unknown) {
    FakeRuntime.instances.push(this);
  }

  boot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolveBoot = resolve;
      this.rejectBoot = reject;
    });
  }

  onSerial(listener: SerialListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async attachWorkspace(): Promise<void> {}

  destroy(): void {
    this.destroyed = true;
    this.rejectBoot?.(new Error('destroyed'));
  }

  resolve(): void { this.resolveBoot(); }
  emit(delta: string): void { for (const listener of this.listeners) listener(delta); }
}

const session = { mode: 'workspace', capabilities: ['read'], network: { mode: 'offline' } } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../../src/worker/v86-runtime');
  vi.resetModules();
  FakeRuntime.instances = [];
});

describe('vm.worker lifecycle correlation', () => {
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
});
