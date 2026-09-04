import { isValidWispRelayUrl } from './capabilities';
import { isRiskConsent, type RiskConsent } from '../types/protocol';

export type ConsentContext = {
  workspaceId: string;
  relayUrl: string | null;
};

type SessionStorageArea = {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};
type ConsentMode = RiskConsent['mode'];

const CONSENT_VERSION = 1 as const;
const MODES: readonly ConsentMode[] = ['auto', 'workspace-networked'];
const consentKey = (mode: ConsentMode): string => `kcode.risk-consent.${mode}`;
const keys = MODES.map(consentKey);
const consentError = (code: string): Error => new Error(code);

const hasActiveUserActivation = (): boolean =>
  typeof navigator !== 'undefined'
  && (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation?.isActive === true;

export const normalizeRelayUrl = (relayUrl: string): string => {
  if (!isValidWispRelayUrl(relayUrl)) throw consentError('CONSENT_INVALID_RELAY_URL');
  return new URL(relayUrl).toString();
};

const normalizeContext = (context: ConsentContext): ConsentContext => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(context.workspaceId)) throw consentError('CONSENT_INVALID_WORKSPACE');
  return { workspaceId: context.workspaceId, relayUrl: context.relayUrl === null ? null : normalizeRelayUrl(context.relayUrl) };
};

const isRequestedModeSet = (modes: readonly ConsentMode[]): boolean =>
  modes.length >= 1
  && modes.length <= MODES.length
  && new Set(modes).size === modes.length
  && modes.every((mode) => MODES.includes(mode));

export interface RiskConsentStore {
  grant(modes: readonly RiskConsent['mode'][], context: ConsentContext): Promise<void>;
  hasValid(mode: RiskConsent['mode'], context: ConsentContext): Promise<boolean>;
  revokeAll(): Promise<void>;
}

/**
 * Trusted Side Panel-only session consent. This class has no Port/message
 * endpoint and intentionally reads storage on every validity check.
 */
export class RiskConsentStore implements RiskConsentStore {
  constructor(private readonly session: SessionStorageArea = chrome.storage.session) {}

  async grant(modes: readonly ConsentMode[], context: ConsentContext): Promise<void> {
    if (!hasActiveUserActivation()) throw consentError('USER_ACTIVATION_REQUIRED');
    if (!isRequestedModeSet(modes)) throw consentError('CONSENT_INVALID_MODES');
    const normalized = normalizeContext(context);
    if (modes.includes('workspace-networked') && normalized.relayUrl === null) {
      throw consentError('CONSENT_RELAY_REQUIRED');
    }
    const grantedAt = Date.now();
    const records = Object.fromEntries(modes.map((mode) => [consentKey(mode), {
      mode,
      workspaceId: normalized.workspaceId,
      relayUrl: normalized.relayUrl,
      consentVersion: CONSENT_VERSION,
      grantedAt,
    } satisfies RiskConsent]));
    try {
      await this.session.set(records);
      const stored = await this.session.get(modes.map(consentKey));
      if (!modes.every((mode) => {
        const record = stored[consentKey(mode)];
        return isRiskConsent(record)
          && record.mode === mode
          && record.workspaceId === normalized.workspaceId
          && record.relayUrl === normalized.relayUrl
          && record.consentVersion === CONSENT_VERSION
          && record.grantedAt === grantedAt;
      })) throw consentError('CONSENT_STORAGE_FAILURE');
    } catch {
      await this.removeQuietly(keys);
      throw consentError('CONSENT_STORAGE_FAILURE');
    }
  }

  async hasValid(mode: ConsentMode, context: ConsentContext): Promise<boolean> {
    if (!MODES.includes(mode)) return false;
    let normalized: ConsentContext;
    try {
      normalized = normalizeContext(context);
      if (mode === 'workspace-networked' && normalized.relayUrl === null) return false;
      const stored = await this.session.get(consentKey(mode));
      const record = stored[consentKey(mode)];
      return isRiskConsent(record)
        && record.mode === mode
        && record.consentVersion === CONSENT_VERSION
        && record.workspaceId === normalized.workspaceId
        && record.relayUrl === normalized.relayUrl;
    } catch {
      return false;
    }
  }

  async revokeAll(): Promise<void> {
    try {
      await this.session.remove(keys);
    } catch {
      throw consentError('CONSENT_STORAGE_FAILURE');
    }
  }

  private async removeQuietly(names: readonly string[]): Promise<void> {
    try {
      await this.session.remove([...names]);
    } catch {
      // A failed cleanup cannot turn an unconfirmed grant into a valid one:
      // hasValid always re-reads and requires a complete matching record.
    }
  }
}
