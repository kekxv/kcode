import { visualizeControls } from './untrusted-text';
import type { GuardedResult, LocalToolResult } from '../types/tools';

const RELEASE_BYTES = 256 * 1024;
const BASE64_DECODE_BUDGET = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });
type Match = { kind: string; start: number; end: number };

const patterns: readonly [string, RegExp][] = [
  ['pem-private-key', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9_]{20,}/g],
  ['openai-token', /sk-[A-Za-z0-9_-]{20,}/g],
  ['jwt', /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g],
  ['url-credentials', /https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/g],
  ['protected-marker', /KCODE_PROTECTED_TEST_MARKER/g],
];

const directMatches = (text: string): Match[] => patterns.flatMap(([kind, pattern]) => {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => ({ kind, start: match.index, end: match.index + match[0].length }));
});

const base64Matches = (text: string): Match[] => {
  const matches: Match[] = [];
  let budget = BASE64_DECODE_BUDGET;
  for (const candidate of text.matchAll(/(?:[A-Za-z0-9+/]{4}){6,2048}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g)) {
    if (budget <= 0) break;
    try {
      const bytes = Uint8Array.from(atob(candidate[0]), (character) => character.charCodeAt(0));
      const inspected = bytes.subarray(0, Math.min(bytes.byteLength, budget));
      budget -= inspected.byteLength;
      const found = directMatches(decoder.decode(inspected))[0];
      if (found) matches.push({ kind: `${found.kind}-base64`, start: candidate.index, end: candidate.index + candidate[0].length });
    } catch { /* Invalid-looking spans are ordinary untrusted text. */ }
  }
  return matches;
};

const nonOverlapping = (matches: readonly Match[]): Match[] => {
  const sorted = [...matches].sort((left, right) => left.start - right.start || right.end - left.end);
  const output: Match[] = [];
  for (const match of sorted) if (!output.some((existing) => match.start < existing.end && match.end > existing.start)) output.push(match);
  return output;
};

const truncateUtf8 = (value: string, maximum: number): { text: string; truncated: boolean } => {
  if (encoder.encode(value).byteLength <= maximum) return { text: value, truncated: false };
  let text = '';
  let bytes = 0;
  for (const scalar of value) {
    const scalarBytes = encoder.encode(scalar).byteLength;
    if (bytes + scalarBytes > maximum) break;
    text += scalar;
    bytes += scalarBytes;
  }
  return { text, truncated: true };
};

const wellFormed = (value: string): string => decoder.decode(encoder.encode(value));

export const escapeToolResult = (value: string): string => visualizeControls(wellFormed(value))
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export class DefaultResultGuard {
  scan(text: string): readonly Match[] { return nonOverlapping([...directMatches(text), ...base64Matches(text)]); }

  redact(result: LocalToolResult): GuardedResult {
    const matches = this.scan(result.text);
    let cursor = 0;
    let redacted = '';
    const counts = new Map<string, number>();
    for (const match of matches) {
      redacted += result.text.slice(cursor, match.start);
      redacted += `[REDACTED:${match.kind}]`;
      cursor = match.end;
      counts.set(match.kind, (counts.get(match.kind) ?? 0) + 1);
    }
    redacted += result.text.slice(cursor);
    redacted = visualizeControls(wellFormed(redacted));
    const bounded = truncateUtf8(redacted, RELEASE_BYTES);
    return {
      redactedText: bounded.text,
      findings: [...counts].map(([kind, count]) => ({ kind, count })),
      truncated: result.truncated || bounded.truncated,
      utf8Bytes: encoder.encode(bounded.text).byteLength,
    };
  }
}
