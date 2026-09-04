import { describe, expect, it, vi } from 'vitest';
import { RiskConsentStore } from '../../src/security/risk-consent';

const sessionArea = () => {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).filter((key) => key in values).map((key) => [key, values[key]]),
    )),
    set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }),
  };
};

describe('risk consent security boundary', () => {
  it('removes every tentative consent when a combined storage write fails', async () => {
    // Break caught: a partial combined auto/network grant remains usable after persistence fails.
    const session = sessionArea();
    session.set.mockRejectedValueOnce(new Error('quota'));
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    const store = new RiskConsentStore(session);

    await expect(store.grant(['auto', 'workspace-networked'], {
      workspaceId: 'workspace-1', relayUrl: 'wss://relay.example/tenant',
    })).rejects.toThrow('CONSENT_STORAGE_FAILURE');

    expect(session.remove).toHaveBeenCalledWith(['kcode.risk-consent.auto', 'kcode.risk-consent.workspace-networked']);
    expect(await store.hasValid('auto', { workspaceId: 'workspace-1', relayUrl: 'wss://relay.example/tenant' })).toBe(false);
  });

  it('verifies both records after a combined write so a partial success cannot activate either mode', async () => {
    // Break caught: a storage implementation reports success after persisting only auto consent.
    const session = sessionArea();
    session.set.mockImplementationOnce(async (next: Record<string, unknown>) => {
      session.values['kcode.risk-consent.auto'] = next['kcode.risk-consent.auto'];
    });
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });

    await expect(new RiskConsentStore(session).grant(['auto', 'workspace-networked'], {
      workspaceId: 'workspace-1', relayUrl: 'wss://relay.example/tenant',
    })).rejects.toThrow('CONSENT_STORAGE_FAILURE');

    expect(session.values).toEqual({});
  });

  it('fails closed when records were cleared at browser session end or revoked', async () => {
    // Break caught: a cached consent survives session storage loss or an explicit revoke.
    const session = sessionArea();
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    const store = new RiskConsentStore(session);
    const context = { workspaceId: 'workspace-1', relayUrl: null };
    await store.grant(['auto'], context);
    expect(await store.hasValid('auto', context)).toBe(true);
    await store.revokeAll();
    expect(await store.hasValid('auto', context)).toBe(false);
    expect(session.values).toEqual({});
  });
});
