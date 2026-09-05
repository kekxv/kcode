import { isSensitivePath } from '../security/sensitive-paths';
import { normalizeWorkspacePath } from '../utils/path';
import type { AssistantTurn, ToolCall } from '../types/tools';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TAG_BYTES = 300 * 1024;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 1_048_576;
const encoder = new TextEncoder();
type RecordValue = Record<string, unknown>;

const invalid = (code = 'TOOL_CALL_INVALID'): never => { throw new Error(code); };
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: RecordValue, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const integerIn = (value: unknown, minimum: number, maximum: number): value is number => Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;

const path = (value: unknown): string => {
  if (typeof value !== 'string') return invalid();
  let segments;
  try { segments = normalizeWorkspacePath(value); } catch { return invalid(); }
  if (isSensitivePath(segments)) return invalid();
  return segments.join('/');
};

const parseCall = (value: unknown): ToolCall => {
  if (!record(value) || !exact(value, ['id', 'tool', 'args']) || typeof value.id !== 'string' || !ID.test(value.id) || !record(value.args)) return invalid();
  if (value.tool === 'bash') {
    const args = value.args;
    if (!(exact(args, ['cmd', 'workspace']) || exact(args, ['cmd', 'workspace', 'timeoutMs']))
      || typeof args.cmd !== 'string' || args.cmd.trim().length === 0
      || !['read', 'write', 'delete'].includes(args.workspace as string)
      || ('timeoutMs' in args && !integerIn(args.timeoutMs, 1_000, 600_000))) return invalid();
    if (encoder.encode(args.cmd).byteLength > MAX_COMMAND_BYTES) return invalid('TOOL_COMMAND_TOO_LARGE');
    return { id: value.id, tool: 'bash', args: { cmd: args.cmd, workspace: args.workspace as 'read' | 'write' | 'delete', ...('timeoutMs' in args ? { timeoutMs: args.timeoutMs as number } : {}) } };
  }
  if (value.tool === 'read_file') {
    const args = value.args;
    if (!(exact(args, ['path']) || exact(args, ['path', 'maxBytes'])) || ('maxBytes' in args && !integerIn(args.maxBytes, 1, MAX_FILE_BYTES))) return invalid();
    return { id: value.id, tool: 'read_file', args: { path: path(args.path), ...('maxBytes' in args ? { maxBytes: args.maxBytes as number } : {}) } };
  }
  if (value.tool === 'write_file') {
    const args = value.args;
    if (!exact(args, ['path', 'content']) || typeof args.content !== 'string' || encoder.encode(args.content).byteLength > MAX_FILE_BYTES) return invalid();
    return { id: value.id, tool: 'write_file', args: { path: path(args.path), content: args.content } };
  }
  if (value.tool === 'fetch') {
    const args = value.args;
    if (!(exact(args, ['url']) || exact(args, ['url', 'maxBytes'])) || typeof args.url !== 'string' || ('maxBytes' in args && !integerIn(args.maxBytes, 1, MAX_FILE_BYTES))) return invalid();
    let url: URL;
    try { url = new URL(args.url); } catch { return invalid(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || encoder.encode(url.href).byteLength > 8 * 1024) return invalid();
    return { id: value.id, tool: 'fetch', args: { url: url.href, ...('maxBytes' in args ? { maxBytes: args.maxBytes as number } : {}) } };
  }
  return invalid();
};

export const parseAssistantTurn = (text: string): AssistantTurn => {
  if (typeof text !== 'string') return invalid();
  if (!text.includes('<tool_call>') && !text.includes('</tool_call>')) return { kind: 'final', text };
  if (encoder.encode(text).byteLength > MAX_TAG_BYTES) return invalid('TOOL_CALL_TOO_LARGE');
  const match = text.match(/^\s*<tool_call>([\s\S]*)<\/tool_call>\s*$/);
  if (!match || match[1].includes('<tool_call>') || match[1].includes('</tool_call>')) return invalid();
  try { return { kind: 'tool', call: parseCall(JSON.parse(match[1])) }; } catch (error) {
    if (error instanceof Error && error.message.startsWith('TOOL_')) throw error;
    return invalid();
  }
};
