import { describe, expect, it } from 'vitest';
import type { WorkspaceCapability } from '../../src/types/protocol';
import { canUseNetwork, hasWorkspaceCapability, parseSession } from '../../src/security/capabilities';
import { isSensitivePath } from '../../src/security/sensitive-paths';
import { normalizeWorkspacePath } from '../../src/utils/path';

describe('workspace session parsing', () => {
  it('accepts a workspace with WISP and rejects malformed network state', () => {
    const session = parseSession({
      mode: 'workspace', capabilities: ['read'],
      network: { mode: 'wisp', relayUrl: 'wss://relay.test.invalid/wisp' },
    });

    expect(session.network.mode).toBe('wisp');
    expect(canUseNetwork(session)).toBe(true);
    expect(() => parseSession({
      mode: 'workspace', capabilities: ['read'],
      network: { mode: 'offline', relayUrl: 'wss://relay.test.invalid/wisp' },
    })).toThrow('INVALID_SESSION');
    expect(() => parseSession({
      mode: 'workspace', capabilities: ['read'],
      network: { mode: 'wisp', relayUrl: 'ws://relay.test.invalid/wisp' },
    })).toThrow('INVALID_RELAY_URL');
  });

  it.each([
    { mode: 'workspace', capabilities: ['read', 'read'], network: { mode: 'offline' } },
    { mode: 'workspace', capabilities: ['read'], network: { mode: 'offline' }, unexpected: true },
  ])('rejects ambiguous or malformed session state', (session) => {
    expect(() => parseSession(session)).toThrow('INVALID_SESSION');
  });

  it.each([
    'wss://user:pass@relay.test.invalid/wisp',
    'wss://relay.test.invalid/wisp#fragment',
  ])('rejects a relay URL with credentials or fragments: %s', (relayUrl) => {
    expect(() => parseSession({
      mode: 'workspace', capabilities: ['read'], network: { mode: 'wisp', relayUrl },
    })).toThrow('INVALID_RELAY_URL');
  });

  it('copies and freezes capabilities so later input mutation cannot escalate access', () => {
    const capabilities = ['read'];
    const session = parseSession({ mode: 'workspace', capabilities, network: { mode: 'offline' } });

    capabilities.push('write');

    expect(hasWorkspaceCapability(session, 'write')).toBe(false);
    expect(() => (session.capabilities as WorkspaceCapability[]).push('write')).toThrow(TypeError);
  });
});

describe('sensitive workspace paths', () => {
  it.each([
    '.env', '.env.production', 'id_rsa', 'id_ed25519', 'certs/server.key',
    '.ssh/config', '.aws/credentials', '.azure/profile', '.config/gcloud/application_default_credentials.json',
    '.npmrc', '.pypirc', 'tls/client.pem', 'archive/client.p12', 'archive/client.pfx',
  ])('denies protected path %s', (path) => {
    expect(isSensitivePath(normalizeWorkspacePath(path))).toBe(true);
  });

  it.each(['.env.example', '.env.sample', '.env.template', 'src/.env.example'])(
    'allows deliberate non-secret fixture %s',
    (path) => expect(isSensitivePath(normalizeWorkspacePath(path))).toBe(false),
  );

  it('case-folds and normalizes Unicode before checking protected names', () => {
    expect(isSensitivePath(normalizeWorkspacePath('.SSH/CONFIG'))).toBe(true);
    expect(isSensitivePath(normalizeWorkspacePath('CAFE\u0301.PEM'))).toBe(true);
  });

  it('matches compatibility-equivalent protected names such as long-s', () => {
    expect(isSensitivePath(normalizeWorkspacePath('.ſsh/config'))).toBe(true);
    expect(isSensitivePath(normalizeWorkspacePath('ｉｄ_ｒſa'))).toBe(true);
  });
});
