import type { WorkspaceCapability, WorkspaceSession } from '../types/protocol';

type PlainRecord = Record<string, unknown>;

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

const invalidSession = (): never => {
  throw new Error('INVALID_SESSION');
};

const parseRelayUrl = (value: unknown): string => {
  if (typeof value !== 'string') return invalidSession();
  try {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || url.username !== '' || url.password !== '' || url.hash !== '') {
      throw new Error('invalid relay');
    }
    return value;
  } catch {
    throw new Error('INVALID_RELAY_URL');
  }
};

/** Parses only the exact workspace session shape allowed across trust boundaries. */
export const parseSession = (value: unknown): WorkspaceSession => {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['mode', 'capabilities', 'network']) || value.mode !== 'workspace') {
    return invalidSession();
  }
  if (!Array.isArray(value.capabilities) || !value.capabilities.every(isCapability)
    || new Set(value.capabilities).size !== value.capabilities.length) return invalidSession();
  if (!isPlainRecord(value.network)) return invalidSession();
  if (value.network.mode === 'offline') {
    if (!hasExactKeys(value.network, ['mode'])) return invalidSession();
    return { mode: 'workspace', capabilities: value.capabilities, network: { mode: 'offline' } };
  }
  if (value.network.mode !== 'wisp' || !hasExactKeys(value.network, ['mode', 'relayUrl'])) return invalidSession();
  return {
    mode: 'workspace',
    capabilities: value.capabilities,
    network: { mode: 'wisp', relayUrl: parseRelayUrl(value.network.relayUrl) },
  };
};

export const hasWorkspaceCapability = (
  session: WorkspaceSession,
  capability: WorkspaceCapability,
): boolean => session.capabilities.includes(capability);

export const canUseNetwork = (session: WorkspaceSession): boolean =>
  session.network.mode === 'wisp';
