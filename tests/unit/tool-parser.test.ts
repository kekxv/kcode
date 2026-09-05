import { describe, expect, it } from 'vitest';
import { parseAssistantTurn } from '../../src/sidepanel/tool-parser';

const tool = (value: unknown): string => `<tool_call>${JSON.stringify(value)}</tool_call>`;

describe('parseAssistantTurn', () => {
  it('accepts one exact bash call and derives its declared maximum capability', () => {
    const parsed = parseAssistantTurn(tool({ id: 'call_1', tool: 'bash', args: { cmd: 'find . -maxdepth 2', workspace: 'read', timeoutMs: 5_000 } }));
    expect(parsed).toEqual({ kind: 'tool', call: { id: 'call_1', tool: 'bash', args: { cmd: 'find . -maxdepth 2', workspace: 'read', timeoutMs: 5_000 } } });
  });

  it('accepts strict read_file and write_file calls', () => {
    expect(parseAssistantTurn(tool({ id: 'read-1', tool: 'read_file', args: { path: 'src/main.ts', maxBytes: 1024 } }))).toMatchObject({ kind: 'tool', call: { tool: 'read_file' } });
    expect(parseAssistantTurn(tool({ id: 'write-1', tool: 'write_file', args: { path: 'notes.txt', content: 'ok' } }))).toMatchObject({ kind: 'tool', call: { tool: 'write_file' } });
  });

  it('accepts a bounded credential-free HTTPS fetch call', () => {
    // Break caught: the model can only request a read-capability HTTPS URL,
    // never supply headers, credentials, or an unbounded response size.
    expect(parseAssistantTurn(tool({ id: 'fetch-1', tool: 'fetch', args: { url: 'https://example.com/data', maxBytes: 1024 } })))
      .toEqual({ kind: 'tool', call: { id: 'fetch-1', tool: 'fetch', args: { url: 'https://example.com/data', maxBytes: 1024 } } });
  });

  it('treats text without a tool tag as the final answer', () => {
    expect(parseAssistantTurn('任务已完成。')).toEqual({ kind: 'final', text: '任务已完成。' });
  });

  it.each([
    ['extra envelope key', { id: 'x', tool: 'bash', args: { cmd: 'pwd', workspace: 'read' }, extra: true }],
    ['extra args key', { id: 'x', tool: 'bash', args: { cmd: 'pwd', workspace: 'read', nope: true } }],
    ['fetch missing URL', { id: 'x', tool: 'fetch', args: {} }],
    ['non-HTTPS fetch', { id: 'x', tool: 'fetch', args: { url: 'http://example.com' } }],
    ['fetch credentials', { id: 'x', tool: 'fetch', args: { url: 'https://user:password@example.com' } }],
    ['fetch fragment', { id: 'x', tool: 'fetch', args: { url: 'https://example.com/#secret' } }],
    ['oversized fetch URL', { id: 'x', tool: 'fetch', args: { url: `https://example.com/${'a'.repeat(8 * 1024)}` } }],
    ['oversized fetch result', { id: 'x', tool: 'fetch', args: { url: 'https://example.com', maxBytes: 1_048_577 } }],
    ['invalid id', { id: '../x', tool: 'bash', args: { cmd: 'pwd', workspace: 'read' } }],
    ['empty command', { id: 'x', tool: 'bash', args: { cmd: ' ', workspace: 'read' } }],
    ['oversized maxBytes', { id: 'x', tool: 'read_file', args: { path: 'a.txt', maxBytes: 1_048_577 } }],
    ['absolute path', { id: 'x', tool: 'read_file', args: { path: '/etc/passwd' } }],
    ['escaping path', { id: 'x', tool: 'write_file', args: { path: '../outside', content: 'x' } }],
    ['protected path', { id: 'x', tool: 'read_file', args: { path: '.env', maxBytes: 10 } }],
  ])('rejects %s', (_name, call) => {
    expect(() => parseAssistantTurn(tool(call))).toThrow('TOOL_CALL_INVALID');
  });

  it('rejects multiple calls, surrounding prose, malformed JSON, and oversized tags', () => {
    const valid = tool({ id: 'x', tool: 'bash', args: { cmd: 'pwd', workspace: 'read' } });
    expect(() => parseAssistantTurn(`${valid}${valid}`)).toThrow('TOOL_CALL_INVALID');
    expect(() => parseAssistantTurn(`run this ${valid}`)).toThrow('TOOL_CALL_INVALID');
    expect(() => parseAssistantTurn('<tool_call>{</tool_call>')).toThrow('TOOL_CALL_INVALID');
    expect(() => parseAssistantTurn(`<tool_call>${' '.repeat(300 * 1024 + 1)}</tool_call>`)).toThrow('TOOL_CALL_TOO_LARGE');
  });

  it('rejects a UTF-8 command over 32 KiB', () => {
    expect(() => parseAssistantTurn(tool({ id: 'x', tool: 'bash', args: { cmd: '界'.repeat(11_000), workspace: 'read' } }))).toThrow('TOOL_COMMAND_TOO_LARGE');
  });
});
