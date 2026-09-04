/** Messages crossing Chrome runtime Ports are JSON values only. */
export type WorkspaceCapability = 'read' | 'write' | 'delete';

export type NetworkMode =
  | { mode: 'offline' }
  | { mode: 'wisp'; relayUrl: string };

export type WorkspaceSession = {
  mode: 'workspace';
  capabilities: readonly WorkspaceCapability[];
  network: NetworkMode;
};

export type ExecutionMode = 'confirm-each' | 'auto';

export type RiskConsent = {
  mode: 'auto' | 'workspace-networked';
  workspaceId: string;
  relayUrl: string | null;
  consentVersion: 1;
  grantedAt: number;
};

export type SidePanelCommand = {
  protocolVersion: 1;
  kind: 'CONTENT_SEND_PROMPT';
  requestId: string;
  targetTabId: number;
  prompt: string;
};

export type ContentCommand = {
  protocolVersion: 1;
  kind: 'CONTENT_SEND_PROMPT';
  requestId: string;
  prompt: string;
};

export type ContentEvent =
  | { protocolVersion: 1; kind: 'CONTENT_RESPONSE_DELTA'; requestId: string; delta: string }
  | { protocolVersion: 1; kind: 'CONTENT_RESPONSE_DONE'; requestId: string }
  | { protocolVersion: 1; kind: 'CONTENT_ERROR'; requestId: string; code: string; message: string };

export type RoutedContentEvent = ContentEvent & { sourceTabId: number };

/** Dedicated Worker messages use structured clone; handles never cross runtime Ports. */
export type VMRequest =
  | { kind: 'VM_INIT'; requestId: string; session: WorkspaceSession }
  | { kind: 'VM_ATTACH_WORKSPACE'; requestId: string; handle: FileSystemDirectoryHandle }
  | { kind: 'VM_EXEC'; requestId: string; command: string; timeoutMs: number }
  | { kind: 'VM_CANCEL'; requestId: string; targetRequestId: string };

export type VMEvent =
  | { kind: 'VM_READY'; requestId: string }
  | { kind: 'VM_RESULT'; requestId: string; output: string; exitCode: number }
  | { kind: 'VM_ERROR'; requestId: string; code: string; message: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PORT_BYTES = 384 * 1024;
const MAX_DELTA_BYTES = 32 * 1024;
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

export const isNetworkMode = (value: unknown): value is NetworkMode => {
  if (!isRecord(value)) return false;
  if (value.mode === 'offline') return hasExactKeys(value, ['mode']);
  return value.mode === 'wisp'
    && hasExactKeys(value, ['mode', 'relayUrl'])
    && typeof value.relayUrl === 'string'
    && value.relayUrl.length > 0
    && bytesAtMost(value.relayUrl, MAX_PORT_BYTES);
};

export const isWorkspaceSession = (value: unknown): value is WorkspaceSession =>
  isRecord(value)
  && hasExactKeys(value, ['mode', 'capabilities', 'network'])
  && value.mode === 'workspace'
  && Array.isArray(value.capabilities)
  && value.capabilities.every((capability) => capability === 'read' || capability === 'write' || capability === 'delete')
  && new Set(value.capabilities).size === value.capabilities.length
  && isNetworkMode(value.network);

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
  && hasExactKeys(value, ['protocolVersion', 'kind', 'requestId', 'targetTabId', 'prompt'])
  && isPortEnvelope(value)
  && value.kind === 'CONTENT_SEND_PROMPT'
  && isFiniteInteger(value.targetTabId)
  && value.targetTabId >= 0
  && bytesAtMost(value.prompt, MAX_PORT_BYTES);

export const isContentCommand = (value: unknown): value is ContentCommand =>
  isRecord(value)
  && hasExactKeys(value, ['protocolVersion', 'kind', 'requestId', 'prompt'])
  && isPortEnvelope(value)
  && value.kind === 'CONTENT_SEND_PROMPT'
  && bytesAtMost(value.prompt, MAX_PORT_BYTES);

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
      return hasExactKeys(value, ['kind', 'requestId', 'session']) && isWorkspaceSession(value.session);
    case 'VM_ATTACH_WORKSPACE':
      return hasExactKeys(value, ['kind', 'requestId', 'handle']) && isDirectoryHandle(value.handle);
    case 'VM_EXEC':
      return hasExactKeys(value, ['kind', 'requestId', 'command', 'timeoutMs'])
        && bytesAtMost(value.command, MAX_PORT_BYTES)
        && isFiniteInteger(value.timeoutMs)
        && value.timeoutMs > 0;
    case 'VM_CANCEL':
      return hasExactKeys(value, ['kind', 'requestId', 'targetRequestId']) && isId(value.targetRequestId);
    default:
      return false;
  }
};

export const isVMEvent = (value: unknown): value is VMEvent => {
  if (!isRecord(value) || !isId(value.requestId)) return false;
  switch (value.kind) {
    case 'VM_READY':
      return hasExactKeys(value, ['kind', 'requestId']);
    case 'VM_RESULT':
      return hasExactKeys(value, ['kind', 'requestId', 'output', 'exitCode'])
        && bytesAtMost(value.output, MAX_PORT_BYTES)
        && isFiniteInteger(value.exitCode);
    case 'VM_ERROR':
      return hasExactKeys(value, ['kind', 'requestId', 'code', 'message'])
        && isId(value.code)
        && bytesAtMost(value.message, MAX_PORT_BYTES);
    default:
      return false;
  }
};

export const createRequestId = (): string => crypto.randomUUID();
