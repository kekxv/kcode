import type { NetworkMode, WorkspaceCapability, WorkspaceSession } from '../types/protocol';

type PlainRecord = Record<string, unknown>;
const MAX_RELAY_URL_BYTES = 2048;
const encoder = new TextEncoder();

const isPlainRecord = (value: unknown): value is PlainRecord =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const hasExactKeys = (value: PlainRecord, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const isCapability = (value: unknown): value is WorkspaceCapability =>
  value === 'read' || value === 'write' || value === 'delete';

export const isValidWispRelayUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || /[\u0000-\u0020\u007f]/u.test(value) || encoder.encode(value).byteLength > MAX_RELAY_URL_BYTES
    || !/^wss:\/\/[^/]/.test(value) || /%2e/i.test(value)) return false;
  try {
    const url = new URL(value);
    let pathname = url.pathname;
    for (let layer = 0; layer < 2; layer += 1) {
      if (pathname.split('/').some((segment) => segment === '.' || segment === '..')) return false;
      pathname = decodeURIComponent(pathname);
    }
    return url.protocol === 'wss:'
      && url.hostname !== ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
};

export const isValidNetworkMode = (value: unknown): value is NetworkMode => {
  if (!isPlainRecord(value)) return false;
  if (value.mode === 'offline') return hasExactKeys(value, ['mode']);
  return value.mode === 'wisp'
    && hasExactKeys(value, ['mode', 'relayUrl'])
    && isValidWispRelayUrl(value.relayUrl);
};

export const isValidWorkspaceSession = (value: unknown): value is WorkspaceSession =>
  isPlainRecord(value)
  && hasExactKeys(value, ['mode', 'workspaceId', 'capabilities', 'network'])
  && value.mode === 'workspace'
  && typeof value.workspaceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.workspaceId)
  && Array.isArray(value.capabilities)
  && value.capabilities.every(isCapability)
  && new Set(value.capabilities).size === value.capabilities.length
  && isValidNetworkMode(value.network);

const invalidSession = (): never => {
  throw new Error('INVALID_SESSION');
};

const parseRelayUrl = (value: unknown): string => {
  if (typeof value !== 'string') return invalidSession();
  if (!isValidWispRelayUrl(value)) throw new Error('INVALID_RELAY_URL');
  return value;
};

/** Parses only the exact workspace session shape allowed across trust boundaries. */
export const parseSession = (value: unknown): WorkspaceSession => {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['mode', 'workspaceId', 'capabilities', 'network']) || value.mode !== 'workspace'
    || typeof value.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.workspaceId)) {
    return invalidSession();
  }
  if (!Array.isArray(value.capabilities) || !value.capabilities.every(isCapability)
    || new Set(value.capabilities).size !== value.capabilities.length) return invalidSession();
  const capabilities = Object.freeze([...value.capabilities] as WorkspaceCapability[]);
  if (!isPlainRecord(value.network)) return invalidSession();
  if (value.network.mode === 'offline') {
    if (!hasExactKeys(value.network, ['mode'])) return invalidSession();
    return { mode: 'workspace', workspaceId: value.workspaceId, capabilities, network: { mode: 'offline' } };
  }
  if (value.network.mode !== 'wisp' || !hasExactKeys(value.network, ['mode', 'relayUrl'])) return invalidSession();
  return {
    mode: 'workspace',
    workspaceId: value.workspaceId,
    capabilities,
    network: { mode: 'wisp', relayUrl: parseRelayUrl(value.network.relayUrl) },
  };
};

/**
 * Tracks the canonical session accepted by VM dispatch. Task 5 must activate
 * this only after a valid VM_INIT and use isAuthorizedVMRequest for every
 * later Worker message that carries a directory handle.
 */
export class WorkspaceSessionAuthorizer {
  private activeSession: WorkspaceSession | null = null;

  activate(value: unknown): WorkspaceSession {
    this.activeSession = parseSession(value);
    return this.activeSession;
  }

  clear(): void {
    this.activeSession = null;
  }

  canAttachWorkspace(): boolean {
    return this.activeSession?.mode === 'workspace';
  }

  workspaceBinding(): string | null {
    return this.activeSession?.workspaceId ?? null;
  }

  hasCapability(capability: WorkspaceCapability): boolean {
    return this.activeSession?.capabilities.includes(capability) === true;
  }

  /** Mutation authority is fixed at VM_INIT and cannot be supplied by a later guest-facing request. */
  transactionCapabilities(): readonly WorkspaceCapability[] | null {
    const session = this.activeSession;
    if (!session || (!session.capabilities.includes('write') && !session.capabilities.includes('delete'))) return null;
    return Object.freeze([...session.capabilities]);
  }
}

export const hasWorkspaceCapability = (
  session: WorkspaceSession,
  capability: WorkspaceCapability,
): boolean => session.capabilities.includes(capability);

export const canUseNetwork = (session: WorkspaceSession): boolean =>
  session.network.mode === 'wisp';
