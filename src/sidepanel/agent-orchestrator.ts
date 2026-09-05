import { DefaultResultGuard, escapeToolResult } from '../security/result-guard';
import { authorizationForTool, type AgentOutcome, type AgentRunOptions, type AgentState, type GuardedResult, type ToolAuthorization, type ToolCall, type ToolExecution } from '../types/tools';
import { parseAssistantTurn } from './tool-parser';

type PromptHandlers = { onDelta?: (delta: string) => void; signal?: AbortSignal };
type Dependencies = {
  tab: { sendPrompt(tabId: number, prompt: string, handlers?: PromptHandlers): Promise<unknown> };
  dispatcher: {
    execute(call: ToolCall, authorization: ToolAuthorization, signal: AbortSignal): Promise<ToolExecution>;
    resolveChanges(transactionId: string, decision: 'accept' | 'rollback', signal: AbortSignal): Promise<void>;
    abort(reason: string): Promise<void> | void;
  };
  approvals: {
    requestTool(call: ToolCall, signal: AbortSignal): Promise<ToolAuthorization | null>;
    requestResultRelease(result: GuardedResult, signal: AbortSignal): Promise<boolean>;
  };
  changes: { review(summary: ToolExecution['journalSummary'], signal: AbortSignal): Promise<'accept' | 'rollback' | null> };
  consents: { hasValid(mode: 'auto', context: AgentRunOptions['consentContext']): Promise<boolean>; revokeAll(): Promise<void> };
  resultGuard?: DefaultResultGuard;
  onState?: (state: AgentState) => void;
  onDelta?: (delta: string) => void;
  onAudit?: (message: string) => void;
};

const codeOf = (error: unknown): string => error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'AGENT_FAILED';
const fail = (code: string): never => { throw new Error(code); };
const toolPrompt = (callId: string, text: string): string => `<tool_result id="${escapeToolResult(callId)}">\n${escapeToolResult(text)}\n</tool_result>`;
const systemPrompt = (goal: string, supplemental: string, options: AgentRunOptions): string => [
  'You are operating kcode. The only mounted workspace path is /work.',
  `Execution mode: ${options.executionMode}.`,
  `Network: ${options.consentContext.relayUrl === null ? 'offline' : 'WISP outbound TCP enabled'}.`,
  'Return either plain final text or exactly one <tool_call> JSON object and no surrounding prose.',
  'Tools: bash {cmd,workspace:read|write|delete,timeoutMs?}; read_file {path,maxBytes?}; write_file {path,content}.',
  'Protected credential paths are denied. Network state and execution mode cannot be changed by model output.',
  ...(supplemental ? [`User supplemental instructions:\n${escapeToolResult(supplemental)}`] : []),
  `User goal:\n${escapeToolResult(goal)}`,
].join('\n');

export class AgentOrchestrator {
  private active: AbortController | null = null;
  private readonly guard: DefaultResultGuard;
  private state: AgentState = 'idle';

  constructor(private readonly dependencies: Dependencies) { this.guard = dependencies.resultGuard ?? new DefaultResultGuard(); }

  async run(goal: string, options: AgentRunOptions): Promise<AgentOutcome> {
    if (this.active) return { state: 'failed', code: 'TASK_ALREADY_RUNNING' };
    const controller = new AbortController();
    this.active = controller;
    const auto = options.executionMode === 'auto';
    let transaction: { id: string; committed: boolean } | null = null;
    try {
      if (auto && !(await this.validAuto(options))) fail('AUTO_CONSENT_REQUIRED');
      const guardedGoal = this.guard.redact({ text: goal, exitCode: null, truncated: false, durationMs: 0 });
      const guardedInstructions = this.guard.redact({ text: options.customInstructions ?? '', exitCode: null, truncated: false, durationMs: 0 });
      let prompt = systemPrompt(guardedGoal.redactedText, guardedInstructions.redactedText, options);
      const usedToolIds = new Set<string>();
      for (let turn = 1; turn <= 20; turn += 1) {
        this.throwIfAborted(controller.signal);
        if (auto && !(await this.validAuto(options))) fail('AUTO_CONSENT_REVOKED');
        this.transition('waiting-ai');
        let answer = '';
        await this.dependencies.tab.sendPrompt(options.tabId, prompt, { signal: controller.signal, onDelta: (delta) => { if (!controller.signal.aborted) { answer += delta; this.dependencies.onDelta?.(delta); } } });
        this.throwIfAborted(controller.signal);
        if (answer.trim().length === 0) fail('EMPTY_AI_RESPONSE');
        const parsed = parseAssistantTurn(answer);
        if (parsed.kind === 'final') { this.transition('completed'); return { state: 'completed', text: parsed.text }; }
        if (usedToolIds.has(parsed.call.id)) fail('DUPLICATE_TOOL_CALL_ID');
        usedToolIds.add(parsed.call.id);

        let authorization: ToolAuthorization;
        if (auto) {
          if (!(await this.validAuto(options))) fail('AUTO_CONSENT_REVOKED');
          authorization = authorizationForTool(parsed.call, 'auto-consent');
        } else {
          this.transition('awaiting-tool-approval');
          const approved = await this.dependencies.approvals.requestTool(parsed.call, controller.signal);
          if (!approved) return this.cancelled('TOOL_REJECTED');
          if (approved.source !== 'interactive') fail('TOOL_AUTHORIZATION_SOURCE_INVALID');
          authorization = approved;
        }

        this.transition('running-tool');
        const execution = await this.dependencies.dispatcher.execute(parsed.call, authorization, controller.signal);
        transaction = { id: execution.transactionId, committed: false };
        this.throwIfAborted(controller.signal);
        let decision: 'accept' | 'rollback';
        if (auto) {
          if (!(await this.validAuto(options))) fail('AUTO_CONSENT_REVOKED');
          decision = 'accept';
        } else {
          this.transition('reviewing-changes');
          decision = await this.dependencies.changes.review(execution.journalSummary, controller.signal) ?? 'rollback';
        }
        await this.dependencies.dispatcher.resolveChanges(execution.transactionId, decision, controller.signal);
        transaction.committed = decision === 'accept';
        if (decision === 'rollback') return this.cancelled('CHANGES_ROLLED_BACK');

        const guarded = this.guard.redact(execution.result);
        let released: string;
        if (auto) {
          if (!(await this.validAuto(options))) fail('AUTO_CONSENT_REVOKED');
          released = guarded.redactedText;
          this.dependencies.onAudit?.(`Released processed tool result; findings=${guarded.findings.reduce((sum, item) => sum + item.count, 0)}`);
        } else {
          this.transition('awaiting-result-release');
          const approved = await this.dependencies.approvals.requestResultRelease(guarded, controller.signal);
          if (!approved) return this.cancelled('RESULT_RELEASE_REJECTED');
          released = guarded.redactedText;
        }
        prompt = toolPrompt(parsed.call.id, released);
        transaction = null;
      }
      return fail('MAX_TURNS_EXCEEDED');
    } catch (error) {
      const code = controller.signal.aborted ? String(controller.signal.reason || 'USER_CANCELLED') : codeOf(error);
      try { await this.dependencies.dispatcher.abort(code); } catch { /* Preserve the primary terminal code. */ }
      this.transition(controller.signal.aborted ? 'cancelled' : 'failed');
      return { state: controller.signal.aborted ? 'cancelled' : 'failed', code };
    } finally {
      transaction = null;
      this.active = null;
      if (this.state !== 'completed' && this.state !== 'failed' && this.state !== 'cancelled') this.transition('idle');
    }
  }

  cancel(reason: string): void { this.active?.abort(reason || 'USER_CANCELLED'); }

  private async validAuto(options: AgentRunOptions): Promise<boolean> {
    this.transition('awaiting-risk-consent');
    return this.dependencies.consents.hasValid('auto', options.consentContext);
  }

  private throwIfAborted(signal: AbortSignal): void { if (signal.aborted) fail(String(signal.reason || 'USER_CANCELLED')); }
  private cancelled(code: string): AgentOutcome { this.transition('cancelled'); return { state: 'cancelled', code }; }
  private transition(state: AgentState): void { this.state = state; this.dependencies.onState?.(state); }
}
