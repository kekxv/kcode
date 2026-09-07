import { isSensitivePath } from '../security/sensitive-paths';
import { normalizeWorkspacePath } from '../utils/path';
import type { AssistantTurn, ToolCall } from '../types/tools';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TAG_BYTES = 300 * 1024;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 1_048_576;
const encoder = new TextEncoder();
type RecordValue = Record<string, unknown>;

export class ToolParseError extends Error {
  constructor(code: string, readonly detail: string) { super(code); this.name = 'ToolParseError'; }
}
const invalid = (code = 'TOOL_CALL_INVALID', detail = '工具调用结构无效；请使用一个完整的 tool_call JSON 对象。'): never => { throw new ToolParseError(code, detail); };
const problem = (detail: string): never => invalid('TOOL_CALL_INVALID', detail);
const keysFor = (value: RecordValue, required: string[], optional: string[] = [], location = 'args'): void => {
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (missing.length) problem(`${location} 缺少必填字段：${missing.join(', ')}。`);
  if (Object.keys(value).some(key => ![...required, ...optional].includes(key))) problem(`${location} 包含不支持的字段；允许字段：${[...required, ...optional].join(', ')}。`);
};
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: RecordValue, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const integerIn = (value: unknown, minimum: number, maximum: number): value is number => Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;

const path = (value: unknown): string => {
  if (typeof value !== 'string') return problem('args.path 必须是字符串。');
  let segments;
  // /work is the virtual mount, never a host absolute path.
  const relative = value.startsWith('/work/') ? value.slice('/work/'.length) : value;
  try { segments = normalizeWorkspacePath(relative); } catch { return problem('args.path 无效：必须指向 /work 内的文件，不能包含路径穿越或工作区外的绝对路径。'); }
  if (isSensitivePath(segments)) return problem('args.path 指向受保护的敏感文件。');
  return segments.join('/');
};

const parseCall = (value: unknown): ToolCall => {
  if (!record(value)) return problem('tool_call 的 JSON 主体必须是对象，不能是数组或标量。');
  keysFor(value, ['id', 'tool', 'args'], [], 'tool_call');
  if (typeof value.id !== 'string' || !ID.test(value.id)) return problem('id 必须是 1–64 位字母、数字、下划线或连字符组成的字符串。');
  if (!record(value.args)) return problem('args 必须是 JSON 对象。');
  if (typeof value.tool !== 'string' || !['bash', 'read_file', 'write_file', 'edit_file', 'edit', 'fetch'].includes(value.tool)) return problem('tool 不受支持；可用工具：bash, read_file, write_file, edit_file, fetch。');
  const fields = value.args;
  if (value.tool === 'bash') {
    keysFor(fields, ['cmd', 'workspace'], ['timeoutMs']);
    if (typeof fields.cmd !== 'string' || !fields.cmd.trim()) return problem('args.cmd 必须是非空字符串。');
    if (!['read', 'write', 'delete'].includes(fields.workspace as string)) return problem('args.workspace 必须是 read、write 或 delete。');
    if ('timeoutMs' in fields && !integerIn(fields.timeoutMs, 1_000, 600_000)) return problem('args.timeoutMs 必须是 1000–600000 之间的整数（毫秒）。');
  } else if (value.tool === 'read_file' || value.tool === 'fetch') {
    keysFor(fields, [value.tool === 'fetch' ? 'url' : 'path'], ['maxBytes']);
    if ('maxBytes' in fields && !integerIn(fields.maxBytes, 1, MAX_FILE_BYTES)) return problem('args.maxBytes 必须是 1–1048576 之间的整数。');
  } else if (value.tool === 'write_file') {
    keysFor(fields, ['path', 'content']);
    if (typeof fields.content !== 'string') return problem('args.content 必须是字符串。');
    if (encoder.encode(fields.content).byteLength > MAX_FILE_BYTES) return problem('args.content 超过 1 MiB，请拆分写入。');
  } else {
    keysFor(fields, ['path', 'old_string', 'new_string'], ['replace_all']);
    if (typeof fields.old_string !== 'string' || !fields.old_string.length) return problem('args.old_string 必须是非空字符串。');
    if (typeof fields.new_string !== 'string') return problem('args.new_string 必须是字符串。');
    if ('replace_all' in fields && typeof fields.replace_all !== 'boolean') return problem('args.replace_all 必须是布尔值。');
  }
  if (value.tool === 'bash') {
    const args = value.args;
    if (!(exact(args, ['cmd', 'workspace']) || exact(args, ['cmd', 'workspace', 'timeoutMs']))
      || typeof args.cmd !== 'string' || args.cmd.trim().length === 0
      || !['read', 'write', 'delete'].includes(args.workspace as string)
      || ('timeoutMs' in args && !integerIn(args.timeoutMs, 1_000, 600_000))) return invalid();
    if (encoder.encode(args.cmd).byteLength > MAX_COMMAND_BYTES) return invalid('TOOL_COMMAND_TOO_LARGE', 'args.cmd 超过 32 KiB，请拆分命令。');
    return { id: value.id, tool: 'bash', args: { cmd: args.cmd, workspace: args.workspace as 'read' | 'write' | 'delete', ...('timeoutMs' in args ? { timeoutMs: args.timeoutMs as number } : {}) } };
  }
  if (value.tool === 'read_file') {
    const args = value.args;
    if (!(exact(args, ['path']) || exact(args, ['path', 'maxBytes'])) || ('maxBytes' in args && !integerIn(args.maxBytes, 1, MAX_FILE_BYTES))) return invalid();
    return { id: value.id, tool: 'read_file', args: { path: path(args.path), ...('maxBytes' in args ? { maxBytes: args.maxBytes as number } : {}) } };
  }
  if (value.tool === 'edit_file' || value.tool === 'edit') {
    const args = value.args;
    if (!(exact(args, ['path', 'old_string', 'new_string']) || exact(args, ['path', 'old_string', 'new_string', 'replace_all']))
      || typeof args.old_string !== 'string' || !args.old_string.length || typeof args.new_string !== 'string'
      || ('replace_all' in args && typeof args.replace_all !== 'boolean')) return invalid();
    return { id: value.id, tool: 'edit_file', args: { path: path(args.path), old_string: args.old_string, new_string: args.new_string, ...('replace_all' in args ? { replace_all: args.replace_all as boolean } : {}) } };
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

/**
 * Qwen's guest chat can ignore the requested JSON envelope and emit its own
 * XML tool syntax. It carries no capability declaration, so every native
 * shell call is conservatively treated as a write-capability request and
 * still goes through the configured authorization flow.
 */
const parseQwenNativeCalls = (text: string, fallbackCallId?: string): ToolCall | null => {
  const source = text.trim();
  if (!/^<tool_call(?:_to_\d+|s)>/.test(source)) return null;
  // Only tolerate a missing `>` immediately before </invoke>. Shell text is
  // opaque: preserve HTML, heredocs, redirects and entities exactly as emitted.
  const envelope = /\s*<(tool_call_to_\d+|tool_calls)>\s*<invoke\s+name=(?:"bash"|'bash')>\s*<parameter\s+name=(?:"cmd"|'cmd')>([\s\S]*?)<\/parameter>?\s*<\/invoke>\s*<\/\1>\s*/y;
  let first: { id: string; cmd: string } | undefined;
  while (envelope.lastIndex < source.length) {
    const match = envelope.exec(source);
    if (!match) return problem('原生 XML 标签不匹配：需要 <tool_calls>（或编号标签）→ <invoke name="bash"> → <parameter name="cmd">，并按相反顺序闭合；未闭合的命令参数不能确认内容完整。');
    const cmd = match[2]!;
    // Reserved tool delimiters inside a command make XML ambiguous. Request
    // JSON instead of guessing where one command ends and another starts.
    if (!cmd.trim() || /<\/?(?:tool_call(?:_to_\d+|s)?|invoke|parameter)\b/.test(cmd)) return invalid();
    if (first && first.cmd !== cmd) return invalid();
    first ??= { id: match[1] === 'tool_calls' ? 'qwen_native' : `qwen_${match[1]!.slice('tool_call_to_'.length)}`, cmd };
  }
  if (!first) return invalid();
  return parseCall({ id: fallbackCallId ?? first.id, tool: 'bash', args: { cmd: first.cmd, workspace: 'write' } });
};

const qwenId = (text: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16_777_619);
  return `qwen_${(hash >>> 0).toString(36)}`;
};

const qwenPath = (value: unknown): string =>
  path(typeof value === 'string' && value.startsWith('/work/') ? value.slice('/work/'.length) : value);

/** Accept Qwen's exact bare JSON tool object after its final stream snapshot. */
const parseQwenBareJson = (text: string, fallbackCallId?: string): ToolCall | null => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!record(value) || typeof value.tool !== 'string') return null;
  const id = fallbackCallId ?? qwenId(text);
  if (value.tool === 'bash' && exact(value, ['tool', 'cmd']) && typeof value.cmd === 'string') {
    return parseCall({ id, tool: 'bash', args: { cmd: value.cmd, workspace: 'write' } });
  }
  if (value.tool === 'read_file' && (exact(value, ['tool', 'path']) || exact(value, ['tool', 'path', 'maxBytes']))) {
    return parseCall({ id, tool: 'read_file', args: { path: qwenPath(value.path), ...('maxBytes' in value ? { maxBytes: value.maxBytes } : {}) } });
  }
  if (value.tool === 'write_file' && exact(value, ['tool', 'path', 'content']) && typeof value.content === 'string') {
    return parseCall({ id, tool: 'write_file', args: { path: qwenPath(value.path), content: value.content } });
  }
  return invalid();
};

/** Qwen also emits a named tool wrapper after a short natural-language preface. */
const parseQwenNamedBash = (text: string, fallbackCallId?: string): ToolCall | null => {
  if (!text.includes('<tool_call_bash') && !text.includes('</tool_call_bash')) return null;
  const envelope = text.match(/^([\s\S]*?)<tool_call_bash>([\s\S]*?)<\/tool_call_bash>\s*$/);
  if (!envelope || /<\/?tool_call(?:\b|_)/.test(envelope[1]!)) return problem('tool_call_bash 外层未正确闭合，或包含多个工具调用。');
  const body = envelope[2]!.trim();
  const parameter = /\s*<arg_key>(cmd|workspace|timeoutMs)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>\s*/y;
  const args: RecordValue = {};
  while (parameter.lastIndex < body.length) {
    const match = parameter.exec(body);
    if (!match) return problem('tool_call_bash 参数结构错误：每个 arg_key 后必须紧跟完整闭合的 arg_value，支持 cmd、workspace、timeoutMs。');
    if (Object.hasOwn(args, match[1]!)) return problem(`tool_call_bash 的 ${match[1]} 参数重复。`);
    const value = match[2]!;
    if (/<\/?(?:arg_key|arg_value|tool_call)(?:\b|_)/.test(value)) return invalid();
    if (match[1] === 'timeoutMs') {
      if (!/^\d+$/.test(value.trim())) return invalid();
      args.timeoutMs = Number(value.trim());
    } else args[match[1]!] = match[1] === 'cmd' ? value : value.trim();
  }
  return parseCall({ id: fallbackCallId ?? qwenId(text), tool: 'bash', args });
};

/** Repair only unescaped HTML attribute delimiters in a final content field.
 * Metadata must already be valid JSON and pass the complete write_file schema.
 * Other broken JSON (including JavaScript strings) must be regenerated.
 */
const jsonProblem = (source: string, error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const match = message.match(/position (\d+)/);
  const position = match ? Number(match[1]) : /end of JSON/i.test(message) ? source.length : undefined;
  const prefix = position === undefined ? '' : source.slice(0, position);
  const location = position === undefined ? '' : `（JSON 主体第 ${prefix.split('\n').length} 行，第 ${prefix.length - prefix.lastIndexOf('\n')} 列，偏移 ${position}）`;
  return problem(`JSON 语法错误${location}：${/end of JSON|unterminated/i.test(message) ? '内容或字符串未结束。' : /escape/i.test(message) ? '字符串中存在非法转义。' : /control character/i.test(message) ? '字符串中存在未转义的换行或控制字符。' : '检查该位置的引号、逗号、括号及字符串转义。'}`);
};

const parseJsonCall = (source: string): ToolCall => {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch (error) {
    const match = source.match(/^([\s\S]*?"content"\s*:\s*)"([\s\S]*)"\s*}\s*}\s*$/);
    if (!match) return jsonProblem(source, error);
    let metadata: ToolCall;
    try { metadata = parseCall(JSON.parse(`${match[1]}""}}`)); }
    catch (metadataError) { if (metadataError instanceof ToolParseError) throw metadataError; return jsonProblem(source, error); }
    if (metadata.tool !== 'write_file') return jsonProblem(source, error);
    const raw = match[2]!;
    if (!/^\s*(?:<!doctype html>\s*|<!doctype html>\\n\s*)?<html(?:\s|>)/i.test(raw)
      || !/<\/html>\s*$/i.test(raw)
      || /<\/?tool_call\b|<\/?tool_call_to_|<\/?tool_calls\b/.test(raw)) return jsonProblem(source, error);
    const repaired = raw.replace(/<[a-zA-Z][^<>]*>/g, tag =>
      tag.replace(/(\s[\w:-]+\s*=\s*)"([^"\\]*)"/g, (_all, name: string, attribute: string) =>
        `${name}\\"${attribute}\\"`));
    try { value = JSON.parse(`${match[1]}"${repaired}"}}`); }
    catch { return jsonProblem(source, error); }
  }
  return parseCall(value);
};

/** Only append envelope closings once the payload has an unambiguous end.
 * Never invent JSON, argument values, command text or mismatched inner tags.
 */
const completeTrailingEnvelope = (text: string): string => {
  const source = text.trimEnd();
  const json = source.match(/^\s*<(tool_call|tool_call_to_\d+|tool_calls)(?:\s+id\s*=\s*(["'])([A-Za-z0-9_-]{1,64})\2)?\s*>\s*(\{[\s\S]*)$/);
  if (json) {
    const closing = `</${json[1]}>`;
    for (let length = 0; length < closing.length; length += 1) {
      if (length && !source.endsWith(closing.slice(0, length))) continue;
      const payload = length ? json[4]!.slice(0, -length).trimEnd() : json[4]!.trimEnd();
      try { JSON.parse(payload); } catch { continue; }
      return source + closing.slice(length);
    }
  }
  const native = source.match(/^\s*<(tool_call_to_\d+|tool_calls)>/);
  if (native) {
    if (/<\/parameter>\s*$/.test(source)) return source + `</invoke></${native[1]}>`;
    if (/<\/invoke>\s*$/.test(source)) return source + `</${native[1]}>`;
  }
  if (/^\s*<tool_call_bash>/.test(source) && /<\/arg_value>\s*$/.test(source)) return source + '</tool_call_bash>';
  return text;
};

// Native indices are local to a response; the orchestrator supplies a turn ID
// for native/bare calls. Explicit JSON IDs still retain replay protection.
export const parseAssistantTurn = (text: string, fallbackCallId?: string): AssistantTurn => {
  if (typeof text !== 'string') return invalid();
  if (/<\/?tool_call(?:\b|_)/.test(text) && encoder.encode(text).byteLength > MAX_TAG_BYTES) return invalid('TOOL_CALL_TOO_LARGE', '工具调用超过 300 KiB，请拆分为多个较小步骤。');
  // Prose may precede one complete code fence. Keep the entire body so two
  // calls or trailing executable envelopes still fail normal validation.
  const fenced = text.trim().match(/^(?:[^]*?\n)?(`{3,}|~{3,})(?:xml|json|text)?[ \t]*\r?\n([\s\S]*)\r?\n\1[ \t]*$/i);
  if (fenced && /^\s*<tool_call(?=[\s_>])/.test(fenced[2]!) && !/<\/?tool_call(?:\b|_)/.test(text.slice(0, text.indexOf(fenced[1]!)))) text = fenced[2]!;
  const toolStart = text.search(/<tool_call(?=[\s_>])/);
  if (toolStart > 0) {
    if (encoder.encode(text).byteLength > MAX_TAG_BYTES) return invalid('TOOL_CALL_TOO_LARGE', '工具调用超过 300 KiB，请拆分为多个较小步骤。');
    if (/<\/tool_call(?:\b|_)/.test(text.slice(0, toolStart))) return invalid();
    text = text.slice(toolStart);
  }
  text = completeTrailingEnvelope(text);
  // Qwen sometimes repeats the opening ID attribute on its closing tag.
  // Accept this spelling only when both wrapper IDs agree with the JSON ID.
  const attributed = text.match(/^\s*<tool_call\s+id\s*=\s*(["'])([A-Za-z0-9_-]{1,64})\1\s*>\s*(\{[\s\S]*)<\/tool_call(?:\s+id\s*=\s*(["'])([A-Za-z0-9_-]{1,64})\4)?\s*>\s*$/);
  if (attributed) {
    if (encoder.encode(text).byteLength > MAX_TAG_BYTES) return invalid('TOOL_CALL_TOO_LARGE', '工具调用超过 300 KiB，请拆分为多个较小步骤。');
    const call = parseJsonCall(attributed[3]!);
    if (call.id !== attributed[2] || (attributed[5] !== undefined && attributed[5] !== call.id)) return problem('tool_call 开始标签、结束标签与 JSON 主体中的 id 不一致。');
    return { kind: 'tool', call };
  }
  const jsonEnvelope = text.match(/^\s*<(tool_call|tool_call_to_\d+|tool_calls)>\s*(\{[\s\S]*)<\/\1>\s*$/);
  if (jsonEnvelope) {
    if (encoder.encode(text).byteLength > MAX_TAG_BYTES) return invalid('TOOL_CALL_TOO_LARGE', '工具调用超过 300 KiB，请拆分为多个较小步骤。');
    return { kind: 'tool', call: parseJsonCall(jsonEnvelope[2]!) };
  }
  if (text.includes('tool_call_bash')) {
    if (encoder.encode(text).byteLength > MAX_TAG_BYTES) return invalid('TOOL_CALL_TOO_LARGE', '工具调用超过 300 KiB，请拆分为多个较小步骤。');
    const named = parseQwenNamedBash(text, fallbackCallId);
    if (named) return { kind: 'tool', call: named };
  }
  if ((text.includes('<tool_call_to_') || text.includes('<tool_calls>')) && encoder.encode(text).byteLength > MAX_TAG_BYTES) return invalid('TOOL_CALL_TOO_LARGE', '工具调用超过 300 KiB，请拆分为多个较小步骤。');
  const qwenNative = parseQwenNativeCalls(text, fallbackCallId);
  if (qwenNative) return { kind: 'tool', call: qwenNative };
  if (text.includes('<tool_call_to_') || text.includes('<tool_calls>')) return invalid();
  const qwenBareJson = parseQwenBareJson(text.trim(), fallbackCallId);
  if (qwenBareJson) return { kind: 'tool', call: qwenBareJson };
  // An unknown or truncated tool envelope is a parse error, never evidence
  // that the user goal is complete. Let the orchestrator request correction.
  if (!/<\/?tool_call(?:\b|_)/.test(text)) return { kind: 'final', text };
  if (encoder.encode(text).byteLength > MAX_TAG_BYTES) return invalid('TOOL_CALL_TOO_LARGE', '工具调用超过 300 KiB，请拆分为多个较小步骤。');
  return problem('XML 外层标签无效：检查 tool_call 开始与结束标签是否一致、是否含有多余属性或多个调用。仅有完整 JSON 且缺末尾闭合时才会自动补全。');
};
