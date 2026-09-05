import { authorizationForTool, type ChangeDecision, type LocalToolResult, type ToolAuthorization, type ToolCall, type ToolExecution } from '../types/tools';
import type { MemoryProfile, NetworkMode, WorkspaceSession } from '../types/protocol';
import type { JournalSummary } from '../worker/p9/mutation-journal';
import type { ConsentContext } from '../security/risk-consent';
import { validateRelayUrl } from '../worker/network-config';

type FileOperationResult = {
  text: string;
  truncated?: boolean;
  durationMs?: number;
  transactionId: string;
  journalSummary: JournalSummary;
};

type DisposableVM = {
  start(session: WorkspaceSession, memoryProfile?: MemoryProfile): Promise<void>;
  attachWorkspace(handle: FileSystemDirectoryHandle): Promise<void>;
  beginTransaction(transactionId: string): Promise<void>;
  exec(command: string, options: { timeoutMs: number }): Promise<{ output: string; exitCode: number; truncated: boolean; durationMs: number; transactionId: string; journalSummary: JournalSummary }>;
  readFile(path: string, maxBytes?: number): Promise<FileOperationResult>;
  writeFile(path: string, content: string): Promise<FileOperationResult>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  terminate(reason: string): void;
};

export type ToolWorkspace = {
  workspaceId: string;
  handle: FileSystemDirectoryHandle;
  network: NetworkMode;
  memoryProfile: MemoryProfile;
};

type WorkspaceProvider = () => Promise<ToolWorkspace>;
type NetworkAuthorizer = (context: ConsentContext) => Promise<boolean>;
type ActiveTransaction = { transactionId: string; finalizing: boolean };
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

const failure = (code: string): never => { throw new Error(code); };
const abortCode = (signal: AbortSignal): string => String(signal.reason || 'USER_CANCELLED');
const sameCapabilities = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((capability, index) => capability === right[index]);

/** Executes one parsed tool in one disposable VM generation and retains only its journal finalization handle. */
export class ToolDispatcher {
  private active: ActiveTransaction | null = null;

  constructor(
    private readonly vm: DisposableVM,
    private readonly workspace: WorkspaceProvider,
    private readonly authorizeNetwork: NetworkAuthorizer = async () => false,
  ) {}

  async execute(call: ToolCall, authorization: ToolAuthorization, signal: AbortSignal): Promise<ToolExecution> {
    if (this.active) return failure('TOOL_DISPATCH_BUSY');
    if (signal.aborted) return failure(abortCode(signal));
    const expected = authorizationForTool(call, authorization.source);
    if (!sameCapabilities(authorization.capabilities, expected.capabilities)) return failure('TOOL_AUTHORIZATION_INVALID');

    const selected = await this.workspace();
    if (signal.aborted) return failure(abortCode(signal));
    if (selected.network.mode === 'wisp') {
      const relayUrl = validateRelayUrl(selected.network.relayUrl).websocketUrl;
      if (!(await this.authorizeNetwork({ workspaceId: selected.workspaceId, relayUrl }))) return failure('NETWORK_CONSENT_REQUIRED');
      selected.network = { mode: 'wisp', relayUrl };
      if (signal.aborted) return failure(abortCode(signal));
    }
    const mutating = expected.capabilities[0] !== 'read';
    const transactionId = mutating ? `tx_${crypto.randomUUID().replaceAll('-', '_')}` : 'no_transaction';
    const active: ActiveTransaction = { transactionId, finalizing: false };
    if (mutating) this.active = active;
    const onAbort = (): void => { void this.abort(abortCode(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.vm.start({
        mode: 'workspace',
        workspaceId: selected.workspaceId,
        capabilities: authorization.capabilities,
        network: selected.network,
      }, selected.memoryProfile);
      if (signal.aborted) return failure(abortCode(signal));
      await this.vm.attachWorkspace(selected.handle);
      if (signal.aborted) return failure(abortCode(signal));
      if (mutating) {
        await this.vm.beginTransaction(transactionId);
        if (signal.aborted) return failure(abortCode(signal));
      }

      if (call.tool === 'bash' || call.tool === 'fetch') {
        const command = call.tool === 'bash'
          ? `cd /work && ${call.args.cmd}`
          : `curl --fail --location --max-time 120 --max-filesize ${call.args.maxBytes ?? 1_048_576} -- ${JSON.stringify(call.args.url)}`;
        const result = await this.vm.exec(command, { timeoutMs: call.tool === 'bash' ? call.args.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS : DEFAULT_COMMAND_TIMEOUT_MS });
        if (result.transactionId !== transactionId) return failure('TOOL_TRANSACTION_MISMATCH');
        return {
          transactionId,
          result: { text: result.output, exitCode: result.exitCode, truncated: result.truncated, durationMs: result.durationMs },
          journalSummary: result.journalSummary,
        };
      }
      const startedAt = performance.now();
      const result = call.tool === 'read_file'
        ? await this.vm.readFile(call.args.path, call.args.maxBytes)
        : await this.vm.writeFile(call.args.path, call.args.content);
      if (result.transactionId !== transactionId) return failure('TOOL_TRANSACTION_MISMATCH');
      return {
        transactionId,
        result: {
          text: result.text,
          exitCode: null,
          truncated: result.truncated ?? false,
          durationMs: result.durationMs ?? Math.max(0, Math.round(performance.now() - startedAt)),
        },
        journalSummary: result.journalSummary,
      };
    } catch (error) {
      await this.finalizeAfterFailure(error instanceof Error ? error.message : 'TOOL_EXEC_FAILED');
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async resolveChanges(transactionId: string, decision: ChangeDecision, signal?: AbortSignal): Promise<void> {
    if (transactionId === 'no_transaction') return;
    const active = this.active;
    if (!active || active.transactionId !== transactionId || active.finalizing) return failure('TOOL_TRANSACTION_INVALID');
    if (signal?.aborted) {
      await this.abort(abortCode(signal));
      return failure(abortCode(signal));
    }
    active.finalizing = true;
    try {
      if (decision === 'accept') await this.vm.commitTransaction();
      else await this.vm.rollbackTransaction();
      if (this.active === active) this.active = null;
    } catch (error) {
      this.vm.terminate(error instanceof Error ? error.message : 'TOOL_TRANSACTION_FAILED');
      throw error;
    }
  }

  async abort(reason: string): Promise<void> {
    const active = this.active;
    if (!active || active.finalizing) {
      this.vm.terminate(reason || 'USER_CANCELLED');
      return;
    }
    active.finalizing = true;
    try {
      await this.vm.rollbackTransaction();
      if (this.active === active) this.active = null;
    } finally {
      this.vm.terminate(reason || 'USER_CANCELLED');
    }
  }

  private async finalizeAfterFailure(reason: string): Promise<void> {
    const active = this.active;
    if (!active) return;
    try { await this.vm.rollbackTransaction(); } catch { /* Durable recovery remains fail-closed. */ }
    if (this.active === active) this.active = null;
    this.vm.terminate(reason || 'TOOL_EXEC_FAILED');
  }
}
