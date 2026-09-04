import { describe, expect, it, vi } from 'vitest';
import { ExecController } from '../../src/worker/exec-controller';

type Listener = (text: string) => void;

class FakeRuntime {
  readonly sent: string[] = [];
  readonly listeners = new Set<Listener>();
  destroyed = false;
  serialSend(command: string): void { this.sent.push(command); }
  onSerial(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  destroy(): void { this.destroyed = true; }
  emit(text: string): void { for (const listener of this.listeners) listener(text); }
}

describe('ExecController', () => {
  it('removes byte-split framing and preserves split UTF-8 output', async () => {
    // Break caught: a delimiter scanner that forwards its partial frame leaks control markers or corrupts multibyte terminal text.
    const runtime = new FakeRuntime();
    const deltas: string[] = [];
    const controller = new ExecController(runtime, { onOutput: (delta) => deltas.push(delta), nonce: () => 'nonce' });
    const pending = controller.exec('printf hi', 1_000);
    const serial = '\x1eKCODE_BEGIN:nonce\x1f\n你好\x1eKCODE_END:nonce:7\x1f\n';
    // Runtime decoding occurs before framing; exercise the framing layer one
    // Unicode code unit at a time, including both marker and UTF-8 text edges.
    for (const character of serial) runtime.emit(character);
    await expect(pending).resolves.toMatchObject({ exitCode: 7, output: '\n你好', truncated: false });
    expect(deltas.join('')).toBe('\n你好');
    expect(runtime.destroyed).toBe(true);
  });

  it('retains one MiB but destroys the VM when total sanitized output exceeds eight MiB', async () => {
    // Break caught: unbounded serial retention can exhaust extension memory instead of containing the disposable VM.
    const runtime = new FakeRuntime();
    const controller = new ExecController(runtime, { nonce: () => 'nonce' });
    const pending = controller.exec('yes', 1_000);
    runtime.emit('\x1eKCODE_BEGIN:nonce\x1f');
    runtime.emit('a'.repeat(8 * 1024 * 1024 + 1));
    await expect(pending).rejects.toThrow('VM_OUTPUT_LIMIT');
    expect(runtime.destroyed).toBe(true);
  });

  it('marks retained output as truncated after one MiB without truncating streamed terminal output', async () => {
    // Break caught: retaining every byte makes ordinary verbose commands consume extension memory before the hard stream budget applies.
    const runtime = new FakeRuntime();
    const deltas: string[] = [];
    const controller = new ExecController(runtime, { nonce: () => 'nonce', onOutput: (delta) => deltas.push(delta) });
    const pending = controller.exec('yes', 1_000);
    runtime.emit('\x1eKCODE_BEGIN:nonce\x1f');
    runtime.emit('a'.repeat(1024 * 1024 + 1));
    runtime.emit('\x1eKCODE_END:nonce:0\x1f');
    await expect(pending).resolves.toMatchObject({ exitCode: 0, output: 'a'.repeat(1024 * 1024), truncated: true });
    expect(deltas.join('')).toHaveLength(1024 * 1024 + 1);
  });

  it('destroys before resolving a forged terminal marker', async () => {
    // Break caught: a root guest can forge a delimiter, so exposing completion before emulator destruction leaves escaped processes alive.
    const runtime = new FakeRuntime();
    let destroyedAtResolution = false;
    const controller = new ExecController(runtime, { nonce: () => 'nonce' });
    const pending = controller.exec('sleep 1 &', 1_000).then(() => { destroyedAtResolution = runtime.destroyed; });
    runtime.emit('\x1eKCODE_BEGIN:nonce\x1foutput\x1eKCODE_END:nonce:not-a-status\x1f');
    await pending;
    expect(destroyedAtResolution).toBe(true);
  });

  it('cancels by destroying without waiting for Ctrl-C cooperation', async () => {
    // Break caught: cancellation that only sends an interrupt lets a guest that ignores Ctrl-C continue running.
    const runtime = new FakeRuntime();
    const controller = new ExecController(runtime, { nonce: () => 'nonce' });
    const pending = controller.exec('trap "" INT; sleep 99', 1_000);
    expect(controller.cancel()).toBe(true);
    await expect(pending).rejects.toThrow('VM_CANCELLED');
    expect(runtime.destroyed).toBe(true);
  });

  it('uses a fixed timeout even when output keeps arriving', async () => {
    // Break caught: output-driven deadline extension lets a noisy command bypass its execution budget.
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    const controller = new ExecController(runtime, { nonce: () => 'nonce' });
    const pending = controller.exec('while :; do echo x; done', 1_000);
    runtime.emit('\x1eKCODE_BEGIN:nonce\x1f');
    runtime.emit('x');
    const expectedTimeout = expect(pending).rejects.toThrow('VM_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1_000);
    await expectedTimeout;
    expect(runtime.destroyed).toBe(true);
    vi.useRealTimers();
  });
});
