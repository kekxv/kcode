export type WatchdogBudget = { timeoutMs: number; maxStreamBytes: 8_388_608; heartbeatTimeoutMs: 5_000 };
export type WatchdogTermination = 'VM_TIMEOUT' | 'VM_HEARTBEAT_TIMEOUT' | 'VM_OUTPUT_LIMIT' | 'VM_PORT_DISCONNECTED' | 'VM_CANCELLED' | 'VM_SUPERSEDED';

export type WatchdogRun = {
  readonly generation: number;
  heartbeat(): void;
  output(bytes: number): void;
  cancel(): void;
  disconnect(): void;
  complete(): void;
};

/** Side-panel owned deadline: native Worker termination never depends on guest or Worker cooperation. */
export class VMWatchdog {
  private generation = 0;
  private current: { generation: number; worker: Worker; deadline: ReturnType<typeof setTimeout>; heartbeat: ReturnType<typeof setTimeout>; bytes: number; done: boolean } | null = null;

  constructor(private readonly onTerminate?: (reason: WatchdogTermination) => void) {}

  run(worker: Worker, budget: WatchdogBudget): WatchdogRun {
    if (this.current) this.terminate(this.current.generation, 'VM_SUPERSEDED');
    const generation = ++this.generation;
    const current = {
      generation, worker, bytes: 0, done: false,
      deadline: setTimeout(() => this.terminate(generation, 'VM_TIMEOUT'), budget.timeoutMs),
      heartbeat: setTimeout(() => this.terminate(generation, 'VM_HEARTBEAT_TIMEOUT'), budget.heartbeatTimeoutMs),
    };
    this.current = current;
    return {
      generation,
      heartbeat: () => { if (!this.isCurrent(generation)) return; clearTimeout(current.heartbeat); current.heartbeat = setTimeout(() => this.terminate(generation, 'VM_HEARTBEAT_TIMEOUT'), budget.heartbeatTimeoutMs); },
      output: (bytes) => { if (!this.isCurrent(generation)) return; current.bytes += bytes; if (current.bytes > budget.maxStreamBytes) this.terminate(generation, 'VM_OUTPUT_LIMIT'); },
      cancel: () => this.terminate(generation, 'VM_CANCELLED'),
      disconnect: () => this.terminate(generation, 'VM_PORT_DISCONNECTED'),
      complete: () => this.complete(generation),
    };
  }

  private isCurrent(generation: number): boolean { return this.current?.generation === generation && !this.current.done; }
  private complete(generation: number): void { if (!this.isCurrent(generation)) return; const current = this.current as NonNullable<typeof this.current>; current.done = true; clearTimeout(current.deadline); clearTimeout(current.heartbeat); this.current = null; }
  private terminate(generation: number, _reason: WatchdogTermination): void {
    if (!this.isCurrent(generation)) return;
    const current = this.current as NonNullable<typeof this.current>;
    current.done = true;
    clearTimeout(current.deadline); clearTimeout(current.heartbeat);
    this.current = null;
    current.worker.terminate();
    this.onTerminate?.(_reason);
  }
}
