import { describe, expect, it, vi } from 'vitest';
import { VMWatchdog } from '../../src/sidepanel/vm-watchdog';

class FakeWorker { terminated = 0; terminate(): void { this.terminated += 1; } }

describe('VMWatchdog', () => {
  it.each([
    ['timeout', (run: ReturnType<VMWatchdog['run']>) => vi.advanceTimersByTimeAsync(120_000)],
    ['missed heartbeat', (run: ReturnType<VMWatchdog['run']>) => vi.advanceTimersByTimeAsync(5_000)],
    ['output budget overflow', (run: ReturnType<VMWatchdog['run']>) => { run.output(8 * 1024 * 1024 + 1); return Promise.resolve(); }],
    ['port disconnect', (run: ReturnType<VMWatchdog['run']>) => { run.disconnect(); return Promise.resolve(); }],
    ['user cancel', (run: ReturnType<VMWatchdog['run']>) => { run.cancel(); return Promise.resolve(); }],
  ])('native-terminates a nonresponsive worker on %s', async (_name, trigger) => {
    // Break caught: relying on a VM Worker acknowledgement leaves runaway v86 execution alive when its event loop is wedged.
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const run = new VMWatchdog().run(worker as unknown as Worker, { timeoutMs: 120_000, maxStreamBytes: 8_388_608, heartbeatTimeoutMs: 5_000 });
    await trigger(run);
    expect(worker.terminated).toBe(1);
    vi.useRealTimers();
  });

  it('does not extend its deadline when guest output arrives', async () => {
    // Break caught: treating guest serial activity as a heartbeat lets output keep a command alive past the side-panel deadline.
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const run = new VMWatchdog().run(worker as unknown as Worker, { timeoutMs: 1_000, maxStreamBytes: 8_388_608, heartbeatTimeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(999);
    run.output(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.terminated).toBe(1);
    vi.useRealTimers();
  });

  it('ignores controls from a superseded generation', () => {
    // Break caught: late messages from an old Worker run can terminate a newer VM generation.
    const watchdog = new VMWatchdog();
    const oldWorker = new FakeWorker();
    const oldRun = watchdog.run(oldWorker as unknown as Worker, { timeoutMs: 1_000, maxStreamBytes: 8_388_608, heartbeatTimeoutMs: 5_000 });
    const worker = new FakeWorker();
    watchdog.run(worker as unknown as Worker, { timeoutMs: 1_000, maxStreamBytes: 8_388_608, heartbeatTimeoutMs: 5_000 });
    oldRun.cancel();
    expect(worker.terminated).toBe(0);
  });
});
