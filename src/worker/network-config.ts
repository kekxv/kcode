import type { NetworkMode } from '../types/protocol';

export type RelayDefinition = {
  websocketUrl: string;
  relayOrigin: string;
  v86RelayUrl: string;
};

const encoder = new TextEncoder();
const invalid = (): never => { throw new Error('INVALID_RELAY_URL'); };

const hasTraversalSegment = (pathname: string): boolean => {
  let candidate = pathname;
  for (let layer = 0; layer < 2; layer += 1) {
    if (candidate.split('/').some((segment) => segment === '.' || segment === '..')) return true;
    try { candidate = decodeURIComponent(candidate); } catch { return true; }
  }
  return candidate.split('/').some((segment) => segment === '.' || segment === '..');
};

export const validateRelayUrl = (input: string): RelayDefinition => {
  if (typeof input !== 'string' || input.length === 0 || encoder.encode(input).byteLength > 2048
    || input !== input.trim() || /[\u0000-\u0020\u007f]/u.test(input)
    || !/^wss:\/\/[^/]/.test(input) || /%2e/i.test(input)) return invalid();
  let url: URL;
  try { url = new URL(input); } catch { return invalid(); }
  if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.search || url.hash
    || hasTraversalSegment(new URL(input).pathname)) return invalid();
  const websocketUrl = url.href;
  return { websocketUrl, relayOrigin: url.origin, v86RelayUrl: websocketUrl.replace(/^wss:/, 'wisps:') };
};

export const toV86NetDevice = (network: NetworkMode): undefined | { type: 'virtio'; relay_url: string } => {
  if (network.mode === 'offline') return undefined;
  return { type: 'virtio', relay_url: validateRelayUrl(network.relayUrl).v86RelayUrl };
};
