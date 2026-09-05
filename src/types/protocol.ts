/** Messages crossing Chrome runtime Ports are JSON values only. */
import {
  isValidNetworkMode,
  isValidWorkspaceSession,
  WorkspaceSessionAuthorizer,
} from '../security/capabilities';
import type { JournalSummary } from '../worker/p9/mutation-journal';

export type WorkspaceCapability = 'read' | 'write' | 'delete';

export type NetworkMode =
  | { mode: 'offline' }
  | { mode: 'wisp'; relayUrl: string };

export type WorkspaceSession = {
  mode: 'workspace';
  /** Stable authenticated selection identity; never accepted on an attach or transaction request. */
  workspaceId: string;
  capabilities: readonly WorkspaceCapability[];
  network: NetworkMode;
};

export type ExecutionMode = 'confirm-each' | 'auto';

/** VM RAM is selected only before a Dedicated Worker is constructed. */
export type MemoryProfile = 'standard' | 'high';
export const VM_MEMORY_PROFILES: Readonly<Record<MemoryProfile, number>> = Object.freeze({
  standard: 256 * 1024 * 1024,
  high: 512 * 1024 * 1024,
});

/** Missing legacy field always means the safe, standard cold-boot profile. */
export const normalizeMemoryProfile = (value: unknown): MemoryProfile | null => {
  if (value === undefined || value === 'standard') return 'standard';
  return value === 'high' ? 'high' : null;
};

export type RiskConsent = {
  mode: 'auto' | 'workspace-networked';
  workspaceId: string;
  relayUrl: string | null;
  consentVersion: 1;
  grantedAt: number;
};

export type SidePanelPromptCommand = {
  protocolVersion: 1;
  kind: 'CONTENT_SEND_PROMPT';
  requestId: string;
  targetTabId: number;
  prompt: string;
};

export type SidePanelListTabsCommand = {
  protocolVersion: 1;
  kind: 'SIDE_PANEL_LIST_CONNECTED_TABS';
  requestId: string;
};

export type SidePanelAbortCommand = {
  protocolVersion: 1;
  kind: 'CONTENT_ABORT_REQUEST';
  requestId: string;
  targetTabId: number;
};

export type SidePanelCommand = SidePanelPromptCommand | SidePanelListTabsCommand | SidePanelAbortCommand;
export type SidePanelEvent = {
  protocolVersion: 1;
  kind: 'SIDE_PANEL_CONNECTED_TABS';
  requestId: string;
  tabs: Array<{ tabId: number; title: string }>;
};

export type ContentSendPromptCommand = {
  protocolVersion: 1;
  kind: 'CONTENT_SEND_PROMPT';
  requestId: string;
  prompt: string;
};

export type ContentAbortRequestCommand = {
  protocolVersion: 1;
  kind: 'CONTENT_ABORT_REQUEST';
  requestId: string;
};

export type ContentCommand = ContentSendPromptCommand | ContentAbortRequestCommand;

export type ContentEvent =
  | { protocolVersion: 1; kind: 'CONTENT_RESPONSE_DELTA'; requestId: string; delta: string }
  | { protocolVersion: 1; kind: 'CONTENT_RESPONSE_DONE'; requestId: string }
  | { protocolVersion: 1; kind: 'CONTENT_ERROR'; requestId: string; code: string; message: string };

export type RoutedContentEvent = ContentEvent & { sourceTabId: number };

/** Dedicated Worker messages use structured clone; handles never cross runtime Ports. */
export type VMRequest =
  | { kind: 'VM_INIT'; requestId: string; session: WorkspaceSession; memoryProfile?: MemoryProfile }
  | { kind: 'VM_ATTACH_WORKSPACE'; requestId: string; handle: FileSystemDirectoryHandle }
  | { kind: 'VM_EXEC'; requestId: string; command: string; timeoutMs: number }
  | { kind: 'VM_READ_FILE'; requestId: string; path: string; maxBytes: number }
  | { kind: 'VM_WRITE_FILE'; requestId: string; path: string; content: string }
  | { kind: 'VM_BEGIN_TRANSACTION'; requestId: string; transactionId: string }
  | { kind: 'VM_COMMIT_TRANSACTION'; requestId: string }
  | { kind: 'VM_ROLLBACK_TRANSACTION'; requestId: string }
  | { kind: 'VM_CANCEL'; requestId: string; targetRequestId: string };

export type VMEvent =
  | { kind: 'VM_READY'; requestId: string }
  | { kind: 'VM_OUTPUT_DELTA'; requestId: string; delta: string }
  | { kind: 'VM_HEARTBEAT'; requestId: string }
  | { kind: 'VM_RESULT'; requestId: string; output: string; exitCode: number; truncated: boolean; durationMs: number; transactionId: string; journalSummary: JournalSummary }
  | { kind: 'VM_FILE_RESULT'; requestId: string; text: string; truncated: boolean; durationMs: number; transactionId: string; journalSummary: JournalSummary }
  | { kind: 'VM_ERROR'; requestId: string; code: string; message: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PORT_BYTES = 384 * 1024;
const MAX_DELTA_BYTES = 32 * 1024;
const MAX_VM_SERIAL_DELTA_BYTES = 64 * 1024;
const MAX_VM_RESULT_OUTPUT_BYTES = 1 * 1024 * 1024;
const MAX_VM_COMMAND_BYTES = 32 * 1024;
const MAX_VM_FILE_BYTES = 1 * 1024 * 1024;
const MAX_VM_PATH_BYTES = 4 * 1024;
const MIN_VM_TIMEOUT_MS = 1_000;
const MAX_VM_TIMEOUT_MS = 600_000;
const encoder = new TextEncoder();

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const hasExactKeys = (value: RecordValue, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const isFiniteInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const bytesAtMost = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && encoder.encode(value).byteLength <= maximum;
const isPortEnvelope = (value: RecordValue): boolean =>
  value.protocolVersion === 1 && isId(value.requestId) && portBytesAtMost(value);

/** Rejects values that cannot safely be represented by Chrome's JSON Port transport. */
export const isJsonValue = (value: unknown): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
};

const portBytesAtMost = (value: unknown): boolean => {
  if (!isJsonValue(value)) return false;
  try {
    return encoder.encode(JSON.stringify(value)).byteLength <= MAX_PORT_BYTES;
  } catch {
    return false;
  }
};

export const isNetworkMode = isValidNetworkMode;

export const isWorkspaceSession = isValidWorkspaceSession;

export const isRiskConsent = (value: unknown): value is RiskConsent =>
  isRecord(value)
  && hasExactKeys(value, ['mode', 'workspaceId', 'relayUrl', 'consentVersion', 'grantedAt'])
  && (value.mode === 'auto' || value.mode === 'workspace-networked')
  && isId(value.workspaceId)
  && (value.relayUrl === null || (typeof value.relayUrl === 'string' && bytesAtMost(value.relayUrl, MAX_PORT_BYTES)))
  && value.consentVersion === 1
  && isFiniteInteger(value.grantedAt)
  && value.grantedAt >= 0;

export const isSidePanelCommand = (value: unknown): value is SidePanelCommand =>
  isRecord(value)
  && isPortEnvelope(value)
  && ((value.kind === 'CONTENT_SEND_PROMPT'
    && hasExactKeys(value, ['protocolVersion', 'kind', 'requestId', 'targetTabId', 'prompt'])
    && isFiniteInteger(value.targetTabId)
    && value.targetTabId >= 0
    && bytesAtMost(value.prompt, MAX_PORT_BYTES))
    || (value.kind === 'SIDE_PANEL_LIST_CONNECTED_TABS'
      && hasExactKeys(value, ['protocolVersion', 'kind', 'requestId']))
    || (value.kind === 'CONTENT_ABORT_REQUEST'
      && hasExactKeys(value, ['protocolVersion', 'kind', 'requestId', 'targetTabId'])
      && isFiniteInteger(value.targetTabId)
      && value.targetTabId >= 0));

export const isSidePanelEvent = (value: unknown): value is SidePanelEvent =>
  isRecord(value)
  && hasExactKeys(value, ['protocolVersion', 'kind', 'requestId', 'tabs'])
  && isPortEnvelope(value)
  && value.kind === 'SIDE_PANEL_CONNECTED_TABS'
  && Array.isArray(value.tabs)
  && value.tabs.every((tab) => isRecord(tab)
    && hasExactKeys(tab, ['tabId', 'title'])
    && isFiniteInteger(tab.tabId)
    && tab.tabId >= 0
    && bytesAtMost(tab.title, MAX_PORT_BYTES));

export const isContentCommand = (value: unknown): value is ContentCommand =>
  isRecord(value)
  && isPortEnvelope(value)
  && ((value.kind === 'CONTENT_SEND_PROMPT'
    && hasExactKeys(value, ['protocolVersion', 'kind', 'requestId', 'prompt'])
    && bytesAtMost(value.prompt, MAX_PORT_BYTES))
    || (value.kind === 'CONTENT_ABORT_REQUEST'
      && hasExactKeys(value, ['protocolVersion', 'kind', 'requestId'])));

export const isContentEvent = (value: unknown): value is ContentEvent => {
  if (!isRecord(value) || !isPortEnvelope(value)) return false;
  switch (value.kind) {
    case 'CONTENT_RESPONSE_DELTA':
      return hasExactKeys(value, ['protocolVersion', 'kind', 'requestId', 'delta'])
        && bytesAtMost(value.delta, MAX_DELTA_BYTES);
    case 'CONTENT_RESPONSE_DONE':
      return hasExactKeys(value, ['protocolVersion', 'kind', 'requestId']);
    case 'CONTENT_ERROR':
      return hasExactKeys(value, ['protocolVersion', 'kind', 'requestId', 'code', 'message'])
        && isId(value.code)
        && bytesAtMost(value.message, MAX_PORT_BYTES);
    default:
      return false;
  }
};

export const isRoutedContentEvent = (value: unknown): value is RoutedContentEvent => {
  if (!isRecord(value) || !portBytesAtMost(value) || !isFiniteInteger(value.sourceTabId) || value.sourceTabId < 0) return false;
  const { sourceTabId: _sourceTabId, ...event } = value;
  return isContentEvent(event);
};

const isDirectoryHandle = (value: unknown): value is FileSystemDirectoryHandle =>
  typeof FileSystemDirectoryHandle !== 'undefined'
  && value instanceof FileSystemDirectoryHandle;

export const isVMRequest = (value: unknown): value is VMRequest => {
  if (!isRecord(value) || !isId(value.requestId)) return false;
  switch (value.kind) {
    case 'VM_INIT':
      return (hasExactKeys(value, ['kind', 'requestId', 'session'])
        || (hasExactKeys(value, ['kind', 'requestId', 'session', 'memoryProfile']) && normalizeMemoryProfile(value.memoryProfile) !== null))
        && isWorkspaceSession(value.session);
    case 'VM_ATTACH_WORKSPACE':
      return hasExactKeys(value, ['kind', 'requestId', 'handle']) && isDirectoryHandle(value.handle);
    case 'VM_EXEC':
      return hasExactKeys(value, ['kind', 'requestId', 'command', 'timeoutMs'])
        && bytesAtMost(value.command, MAX_VM_COMMAND_BYTES)
        && isFiniteInteger(value.timeoutMs)
        && value.timeoutMs >= MIN_VM_TIMEOUT_MS
        && value.timeoutMs <= MAX_VM_TIMEOUT_MS;
    case 'VM_READ_FILE':
      return hasExactKeys(value, ['kind', 'requestId', 'path', 'maxBytes'])
        && bytesAtMost(value.path, MAX_VM_PATH_BYTES)
        && value.path.length > 0
        && isFiniteInteger(value.maxBytes)
        && value.maxBytes >= 1
        && value.maxBytes <= MAX_VM_FILE_BYTES;
    case 'VM_WRITE_FILE':
      return hasExactKeys(value, ['kind', 'requestId', 'path', 'content'])
        && bytesAtMost(value.path, MAX_VM_PATH_BYTES)
        && value.path.length > 0
        && bytesAtMost(value.content, MAX_VM_FILE_BYTES);
    case 'VM_BEGIN_TRANSACTION':
      return hasExactKeys(value, ['kind', 'requestId', 'transactionId']) && isId(value.transactionId);
    case 'VM_COMMIT_TRANSACTION':
    case 'VM_ROLLBACK_TRANSACTION':
      return hasExactKeys(value, ['kind', 'requestId']);
    case 'VM_CANCEL':
      return hasExactKeys(value, ['kind', 'requestId', 'targetRequestId']) && isId(value.targetRequestId);
    default:
      return false;
  }
};

/** Task 5 Worker dispatch must use this guard after VM_INIT establishes session state. */
export const isAuthorizedVMRequest = (
  value: unknown,
  authorizer: WorkspaceSessionAuthorizer,
): value is VMRequest =>
  isVMRequest(value)
  && (value.kind !== 'VM_ATTACH_WORKSPACE' || authorizer.canAttachWorkspace())
  && (value.kind !== 'VM_READ_FILE' || authorizer.hasCapability('read'))
  && (value.kind !== 'VM_WRITE_FILE' || authorizer.hasCapability('write'))
  && (!['VM_BEGIN_TRANSACTION', 'VM_COMMIT_TRANSACTION', 'VM_ROLLBACK_TRANSACTION'].includes(value.kind)
    || authorizer.transactionCapabilities() !== null);

export const isVMEvent = (value: unknown): value is VMEvent => {
  if (!isRecord(value) || !isId(value.requestId)) return false;
  switch (value.kind) {
    case 'VM_READY':
      return hasExactKeys(value, ['kind', 'requestId']);
    case 'VM_OUTPUT_DELTA':
      return hasExactKeys(value, ['kind', 'requestId', 'delta']) && bytesAtMost(value.delta, MAX_VM_SERIAL_DELTA_BYTES);
    case 'VM_HEARTBEAT':
      return hasExactKeys(value, ['kind', 'requestId']);
    case 'VM_RESULT':
      return hasExactKeys(value, ['kind', 'requestId', 'output', 'exitCode', 'truncated', 'durationMs', 'transactionId', 'journalSummary'])
        && bytesAtMost(value.output, MAX_VM_RESULT_OUTPUT_BYTES)
        && isFiniteInteger(value.exitCode)
        && typeof value.truncated === 'boolean'
        && isFiniteInteger(value.durationMs)
        && value.durationMs >= 0
        && isId(value.transactionId)
        && isJournalSummary(value.journalSummary, value.transactionId);
    case 'VM_FILE_RESULT':
      return hasExactKeys(value, ['kind', 'requestId', 'text', 'truncated', 'durationMs', 'transactionId', 'journalSummary'])
        && bytesAtMost(value.text, MAX_VM_FILE_BYTES)
        && typeof value.truncated === 'boolean'
        && isFiniteInteger(value.durationMs)
        && value.durationMs >= 0
        && isId(value.transactionId)
        && isJournalSummary(value.journalSummary, value.transactionId);
    case 'VM_ERROR':
      return hasExactKeys(value, ['kind', 'requestId', 'code', 'message'])
        && isId(value.code)
        && bytesAtMost(value.message, MAX_PORT_BYTES);
    default:
      return false;
  }
};

const isJournalSummary = (value: unknown, transactionId: string): value is JournalSummary =>
  isRecord(value)
  && hasExactKeys(value, ['transactionId', 'state', 'entries', 'journalBytes', 'writtenBytes'])
  && value.transactionId === transactionId
  && (value.state === 'clean' || value.state === 'dirty' || value.state === 'needs-rollback' || value.state === 'conflict')
  && Array.isArray(value.entries)
  && value.entries.every((entry) => isRecord(entry)
    && hasExactKeys(entry, ['path', 'operation', 'originalBytes', 'resultingBytes'])
    && typeof entry.path === 'string' && bytesAtMost(entry.path, MAX_PORT_BYTES)
    && (entry.operation === 'create' || entry.operation === 'write' || entry.operation === 'delete' || entry.operation === 'rename')
    && isFiniteInteger(entry.originalBytes) && entry.originalBytes >= 0
    && isFiniteInteger(entry.resultingBytes) && entry.resultingBytes >= 0)
  && isFiniteInteger(value.journalBytes) && value.journalBytes >= 0
  && isFiniteInteger(value.writtenBytes) && value.writtenBytes >= 0;

export const createRequestId = (): string => crypto.randomUUID();
