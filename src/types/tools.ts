import type { ImageAttachment } from './attachments';
import type { ConsentContext } from '../security/risk-consent';
import type { ExecutionMode, MemoryProfile, WorkspaceCapability } from './protocol';
import type { JournalSummary } from '../worker/p9/mutation-journal';

export type BashToolCall = { id: string; tool: 'bash'; args: { cmd: string; workspace: WorkspaceCapability; timeoutMs?: number } };
export type ReadFileToolCall = { id: string; tool: 'read_file'; args: { path: string; maxBytes?: number } };
export type WriteFileToolCall = { id: string; tool: 'write_file'; args: { path: string; content: string } };
export type FetchToolCall = { id: string; tool: 'fetch'; args: { url: string; maxBytes?: number } };
export type EditFileToolCall = { id: string; tool: 'edit_file'; args: { path: string; old_string: string; new_string: string; replace_all?: boolean } };
export type ToolCall = EditFileToolCall | BashToolCall | ReadFileToolCall | WriteFileToolCall | FetchToolCall;

export type AssistantTurn = { kind: 'final'; text: string } | { kind: 'tool'; call: ToolCall };
export type ChangeDecision = 'accept' | 'rollback';
export type GuardFinding = { kind: string; count: number };
export type GuardedResult = { redactedText: string; findings: readonly GuardFinding[]; truncated: boolean; utf8Bytes: number };
export type LocalToolResult = { text: string; exitCode: number | null; truncated: boolean; durationMs: number };
export type ToolExecution = { transactionId: string; result: LocalToolResult; journalSummary: JournalSummary };
export type ToolAuthorization = { source: 'interactive' | 'auto-consent'; capabilities: readonly WorkspaceCapability[] };
export type AgentRunOptions = { tabId: number; executionMode: ExecutionMode; consentContext: ConsentContext; customInstructions?: string; memoryProfile?: MemoryProfile; images?: ImageAttachment[] };
export type AgentOutcome = { state: 'completed' | 'failed' | 'cancelled'; code?: string; detail?: string; text?: string };
export type AgentState = 'idle' | 'awaiting-risk-consent' | 'waiting-ai' | 'awaiting-tool-approval' | 'running-tool' | 'reviewing-changes' | 'awaiting-result-release' | 'completed' | 'failed' | 'cancelled';

export const authorizationForTool = (call: ToolCall, source: ToolAuthorization['source']): ToolAuthorization => ({
  source,
  capabilities: call.tool === 'edit_file' ? Object.freeze(['read', 'write'] as const) : Object.freeze([call.tool === 'read_file' || call.tool === 'fetch' ? 'read' : call.tool === 'write_file' ? 'write' : call.args.workspace]),
});
