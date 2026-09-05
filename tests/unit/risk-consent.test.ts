import { describe, expect, it, vi } from 'vitest';
import { RiskConsentStore } from '../../src/security/risk-consent';

const activeGesture = (): void => { vi.stubGlobal('navigator', { userActivation: { isActive: true } }); };

const sessionArea = () => {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (keys: string | string[]) => {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => key in values).map((key) => [key, values[key]]));
    }),
    set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }),
  };
};

describe('RiskConsentStore', () => {
  it('defaults to no consent and binds a grant to the normalized complete relay URL', async () => {
    // Break caught: a grant remains valid after a relay path changes, widening network authority.
    const session = sessionArea();
    const store = new RiskConsentStore(session);
    const context = { workspaceId: 'workspace-1', relayUrl: 'wss://relay.example:443/edge' };
    expect(await store.hasValid('auto', context)).toBe(false);
    activeGesture();
    await store.grant(['auto', 'workspace-networked'], context);

    expect(session.set).toHaveBeenCalledTimes(1);
    expect(await store.hasValid('auto', { ...context, relayUrl: 'wss://relay.example/edge' })).toBe(true);
    expect(await store.hasValid('workspace-networked', { ...context, relayUrl: 'wss://relay.example/other' })).toBe(false);
    expect(await store.hasValid('auto', { ...context, workspaceId: 'workspace-2' })).toBe(false);
  });

  it('rejects invalid grants before writing session storage', async () => {
    // Break caught: a forged/malformed mode gains consent or networking without a relay.
    const session = sessionArea();
    const store = new RiskConsentStore(session);
    activeGesture();

    await expect(store.grant(['workspace-networked'], { workspaceId: 'workspace-1', relayUrl: null })).rejects.toThrow('CONSENT_RELAY_REQUIRED');
    await expect(store.grant(['auto', 'auto'], { workspaceId: 'workspace-1', relayUrl: null })).rejects.toThrow('CONSENT_INVALID_MODES');
    await expect(store.grant(['unknown' as never], { workspaceId: 'workspace-1', relayUrl: null })).rejects.toThrow('CONSENT_INVALID_MODES');
    expect(session.set).not.toHaveBeenCalled();
  });

  it('does not grant without an active user activation', async () => {
    // Break caught: restored state or a background message silently grants auto mode.
    const session = sessionArea();
    vi.stubGlobal('navigator', { userActivation: { isActive: false } });
    await expect(new RiskConsentStore(session).grant(['auto'], { workspaceId: 'workspace-1', relayUrl: null }))
      .rejects.toThrow('USER_ACTIVATION_REQUIRED');
    expect(session.set).not.toHaveBeenCalled();
  });
});
