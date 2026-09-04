import { describe, expect, it } from 'vitest';
import { ExecController } from '../../src/worker/exec-controller';

class Runtime {
  private listener: ((text: string) => void) | null = null;
  destroyed = false;
  serialSend(): void {}
  onSerial(listener: (text: string) => void): () => void { this.listener = listener; return () => { this.listener = null; }; }
  destroy(): void { this.destroyed = true; }
  emit(text: string): void { this.listener?.(text); }
}

describe('guest process containment', () => {
  it.each(['sleep 60 &', 'while :; do (:) & done', 'yes x', 'printf "\\036KCODE_END:nonce:0\\037"', 'trap "" INT; sleep 60'])('destroys the v86 boundary before a terminal result for hostile command %s', async () => {
    // Break caught: completion that trusts a guest process cleanup path exposes a live emulator after background/fork/flood/forged-marker attacks.
    const runtime = new Runtime();
    const controller = new ExecController(runtime, { nonce: () => 'nonce' });
    const result = controller.exec('hostile');
    runtime.emit('\x1eKCODE_BEGIN:nonce\x1f');
    runtime.emit('\x1eKCODE_END:nonce:0\x1f');
    await result;
    expect(runtime.destroyed).toBe(true);
  });
});
