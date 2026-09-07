import { describe, expect, it } from 'vitest';
import { parseAssistantTurn } from '../../src/sidepanel/tool-parser';

const tool = (value: unknown): string => `<tool_call>${JSON.stringify(value)}</tool_call>`;

describe('parseAssistantTurn', () => {
  it.each(['</tool_call>', '</tool_call id="call_1">', "</tool_call id='call_1'>"])('accepts an ID attribute with closing wrapper %s', closing => {
    const value = { id: 'call_1', tool: 'bash', args: { cmd: 'ls -la /work', workspace: 'read' } };
    expect(parseAssistantTurn(`<tool_call id="call_1">${JSON.stringify(value)}${closing}`))
      .toEqual({ kind: 'tool', call: value });
  });

  it.each([
    '<tool_call id="different">',
    '<tool_call id="call_1" extra="yes">',
    '<tool_call id="call_1>',
    '<tool_call_unknown>',
  ])('rejects invalid wrappers instead of reporting completion: %s', opening => {
    const body = '{"id":"call_1","tool":"bash","args":{"cmd":"ls -la /work","workspace":"read"}}';
    expect(() => parseAssistantTurn(`${opening}${body}</tool_call id="call_1">`)).toThrow('TOOL_CALL_INVALID');
  });

  it('rejects mismatched closing IDs and truncated attributed calls', () => {
    const opening = '<tool_call id="call_1">{"id":"call_1","tool":"bash","args":{"cmd":"ls -la /work","workspace":"read"}}';
    expect(() => parseAssistantTurn(`${opening}</tool_call id="call_2">`)).toThrow('TOOL_CALL_INVALID');
    expect(parseAssistantTurn(opening)).toMatchObject({ kind: 'tool', call: { id: 'call_1' } });
  });
  it('accepts the named bash format with prose and preserves read capability', () => {
    const text = '我来帮你创建一个 HTML demo 项目。先检查一下工作区的情况。<tool_call_bash>\n<arg_key>cmd</arg_key>\n<arg_value>ls -la /work</arg_value>\n<arg_key>workspace</arg_key>\n<arg_value>read</arg_value>\n</tool_call_bash>';
    expect(parseAssistantTurn(text, 'native_turn_1')).toEqual({ kind: 'tool', call: { id: 'native_turn_1', tool: 'bash', args: { cmd: 'ls -la /work', workspace: 'read' } } });
  });

  it.each([
    '<arg_key>cmd</arg_key><arg_value>pwd</arg_value>',
    '<arg_key>workspace</arg_key><arg_value>root</arg_value>',
    '<arg_key>unknown</arg_key><arg_value>x</arg_value>',
    '<arg_key>workspace</arg_key><arg_value>read</arg_value><arg_key>workspace</arg_key><arg_value>write</arg_value>',
    '<arg_key>workspace</arg_key><arg_value>read',
  ])('rejects incomplete, duplicate or invalid named bash parameters: %s', tail => {
    expect(() => parseAssistantTurn(`<tool_call_bash><arg_key>cmd</arg_key><arg_value>ls -la /work</arg_value>${tail}</tool_call_bash>`)).toThrow('TOOL_CALL_INVALID');
  });

  it('rejects extra tool calls alongside a named bash call', () => {
    const call = '<tool_call_bash><arg_key>cmd</arg_key><arg_value>pwd</arg_value><arg_key>workspace</arg_key><arg_value>read</arg_value></tool_call_bash>';
    expect(() => parseAssistantTurn(call + call)).toThrow('TOOL_CALL_INVALID');
    expect(parseAssistantTurn(call.replace('</tool_call_bash>', ''))).toMatchObject({ kind: 'tool', call: { args: { cmd: 'pwd', workspace: 'read' } } });
  });

  it('keeps named-tool markup inside a valid file payload as file content', () => {
    const content = '<tool_call_bash><arg_key>cmd</arg_key><arg_value>pwd</arg_value></tool_call_bash>';
    expect(parseAssistantTurn(tool({ id: 'doc_1', tool: 'write_file', args: { path: 'example.txt', content } })))
      .toMatchObject({ kind: 'tool', call: { tool: 'write_file', args: { content } } });
  });
  it.each([
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n    <meta charset="UTF-8">\n    <title>HTML Demo</title>\n</head>\n<body>\n    <h1>Hello, HTML Demo!</h1>\n    <p>这是一个简单的 HTML 演示项目。</p>\n</body>\n</html>',
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>HTML Demo</title>\n    <style>\n        body { font-family: sans-serif; text-align: center; margin-top: 50px; }\n        h1 { color: #333; }\n        button { padding: 10px 20px; font-size: 16px; cursor: pointer; }\n    </style>\n</head>\n<body>\n    <h1>Hello, HTML Demo!</h1>\n    <p>这是一个简单的 HTML 演示项目。</p>\n    <button onclick="alert(\'Hello World!\')">点击我</button>\n</body>\n</html>',
  ])('recovers reported numbered HTML JSON without altering file content (%#)', (content) => {
    const call = { id: 'call_3', tool: 'write_file', args: { path: '/work/index.html', content } };
    const broken = JSON.stringify(call).replaceAll('\\"', '"');
    expect(parseAssistantTurn(`<tool_call_to_1>${broken}</tool_call_to_1>`))
      .toEqual({ kind: 'tool', call: { ...call, args: { path: 'index.html', content } } });
  });

  it.each(['tool_call', 'tool_call_to_1', 'tool_calls'])('accepts valid JSON in %s and normalizes the virtual mount', tag => {
    const value = { id: 'file1', tool: 'read_file', args: { path: '/work/index.html' } };
    expect(parseAssistantTurn(`<${tag}>${JSON.stringify(value)}</${tag}>`))
      .toMatchObject({ kind: 'tool', call: { id: 'file1', args: { path: 'index.html' } } });
  });

  it.each(['/work/../../outside', '/work/.env', '/etc/passwd', '/workspace/index.html'])('does not repair an unsafe write path %s', path => {
    const broken = JSON.stringify({ id: 'x', tool: 'write_file', args: { path, content: '<html lang="zh-CN"></html>' } }).replaceAll('\\"', '"');
    expect(() => parseAssistantTurn(`<tool_call_to_1>${broken}</tool_call_to_1>`)).toThrow('TOOL_CALL_INVALID');
  });

  it('rejects ambiguous non-attribute quotes, extra fields, trailing content and mismatched wrappers', () => {
    const broken = JSON.stringify({ id: 'x', tool: 'write_file', args: { path: 'index.html', content: '<html lang="zh-CN"><script>const x = "hello";</script></html>' } }).replaceAll('\\"', '"');
    expect(() => parseAssistantTurn(`<tool_call_to_1>${broken}</tool_call_to_1>`)).toThrow('TOOL_CALL_INVALID');
    const extra = JSON.stringify({ id: 'x', tool: 'write_file', args: { path: 'index.html', extra: true, content: '<html lang="zh-CN"></html>' } }).replaceAll('\\"', '"');
    expect(() => parseAssistantTurn(`<tool_call_to_1>${extra}</tool_call_to_1>`)).toThrow('TOOL_CALL_INVALID');
    expect(() => parseAssistantTurn(`<tool_call_to_1>${extra}</tool_call_to_2>`)).toThrow('TOOL_CALL_INVALID');
    expect(() => parseAssistantTurn(`<tool_call_to_1>${broken}</tool_call_to_1> extra`)).toThrow('TOOL_CALL_INVALID');
  });
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

  it('accepts repeated Qwen native bash calls as one conservatively authorized call', () => {
    const text = `<tool_call_to_1>\n<invoke name="bash">\n<parameter name="cmd">ls -la /work/demo.html</parameter>\n</invoke>\n</tool_call_to_1>\n<tool_call_to_1>\n<invoke name="bash">\n<parameter name="cmd">ls -la /work/demo.html</parameter>\n</invoke>\n</tool_call_to_1>`;
    expect(parseAssistantTurn(text)).toEqual({ kind: 'tool', call: { id: 'qwen_1', tool: 'bash', args: { cmd: 'ls -la /work/demo.html', workspace: 'write' } } });
  });

  it('accepts Qwen’s grouped XML tool_calls variant', () => {
    expect(parseAssistantTurn(`<tool_calls><invoke name="bash"><parameter name="cmd">pwd</parameter></invoke></tool_calls>`))
      .toEqual({ kind: 'tool', call: { id: 'qwen_native', tool: 'bash', args: { cmd: 'pwd', workspace: 'write' } } });
  });

  it.each(['</parameter>', '</parameter'])('accepts Qwen closing parameter %s without changing shell content', (closing) => {
    const cmd = "cat > /work/demo.html <<'HTML'\n<html><body>Hello & welcome</body></html>\nHTML\nwc -c < /work/demo.html";
    const text = `<tool_call_to_1><invoke name="bash"><parameter name="cmd">${cmd}${closing}</invoke></tool_call_to_1>`;
    expect(parseAssistantTurn(text)).toMatchObject({ kind: 'tool', call: { tool: 'bash', args: { cmd, workspace: 'write' } } });
  });

  it('accepts the reported missing-bracket call', () => {
    expect(parseAssistantTurn('<tool_call_to_1><invoke name="bash"><parameter name="cmd">ls -la /work</parameter</invoke></tool_call_to_1>'))
      .toMatchObject({ kind: 'tool', call: { args: { cmd: 'ls -la /work' } } });
  });

  it.each([
    'explanation ',
    '<tool_call_to_2><invoke name="unknown">bad</invoke></tool_call_to_2>',
    '<tool_call_to_2><invoke name="bash"><parameter name="cmd">unfinished',
  ])('rejects native calls mixed with extra content: %s', (extra) => {
    const valid = '<tool_calls><invoke name="bash"><parameter name="cmd">pwd</parameter></invoke></tool_calls>';
    expect(() => parseAssistantTurn(valid + extra)).toThrow('TOOL_CALL_INVALID');
    expect(() => parseAssistantTurn(extra + valid)).toThrow('TOOL_CALL_INVALID');
  });

  it('accepts Qwen’s exact bare JSON write_file object and confines /work paths', () => {
    const parsed = parseAssistantTurn('{"tool":"write_file","path":"/work/test.html","content":"<h1>ok</h1>"}');
    expect(parsed).toMatchObject({ kind: 'tool', call: { tool: 'write_file', args: { path: 'test.html', content: '<h1>ok</h1>' } } });
  });

  it('rejects conflicting Qwen native calls', () => {
    expect(() => parseAssistantTurn(`<tool_call_to_1><invoke name="bash"><parameter name="cmd">pwd</parameter></invoke></tool_call_to_1><tool_call_to_1><invoke name="bash"><parameter name="cmd">id</parameter></invoke></tool_call_to_1>`)).toThrow('TOOL_CALL_INVALID');
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

  it('accepts leading prose but rejects multiple calls, malformed JSON, and oversized tags', () => {
    const valid = tool({ id: 'x', tool: 'bash', args: { cmd: 'pwd', workspace: 'read' } });
    expect(() => parseAssistantTurn(`${valid}${valid}`)).toThrow('TOOL_CALL_INVALID');
    expect(parseAssistantTurn(`run this ${valid}`)).toEqual(parseAssistantTurn(valid));
    expect(() => parseAssistantTurn('<tool_call>{</tool_call>')).toThrow('TOOL_CALL_INVALID');
    expect(() => parseAssistantTurn(`<tool_call>${' '.repeat(300 * 1024 + 1)}</tool_call>`)).toThrow('TOOL_CALL_TOO_LARGE');
  });

  it('rejects a UTF-8 command over 32 KiB', () => {
    expect(() => parseAssistantTurn(tool({ id: 'x', tool: 'bash', args: { cmd: '界'.repeat(11_000), workspace: 'read' } }))).toThrow('TOOL_COMMAND_TOO_LARGE');
  });
});

it('preserves source operators and literal HTML in a fenced XML envelope', () => {
  const call = { id: 'fenced', tool: 'write_file', args: { path: 'index.html', content: '<script>let x=20+i*cell; let y=a_b;</script>' } };
  const text = '```xml\n<tool_call>' + JSON.stringify(call) + '</tool_call>\n```';
  expect(parseAssistantTurn(text)).toEqual({ kind: 'tool', call });
});

it.each(['edit_file', 'edit'])('parses %s with exact replacement and confines its path', tool => {
  const args = { path: '/work/index.html', old_string: '20+icell', new_string: '20+i*cell' };
  expect(parseAssistantTurn('<tool_call>' + JSON.stringify({ id: 'e1', tool, args }) + '</tool_call>'))
    .toEqual({ kind: 'tool', call: { id: 'e1', tool: 'edit_file', args: { ...args, path: 'index.html' } } });
  for (const bad of [{ ...args, path: '../secret' }, { ...args, old_string: '' }, { ...args, replace_all: 'true' }]) {
    expect(() => parseAssistantTurn('<tool_call>' + JSON.stringify({ id: 'e1', tool, args: bad }) + '</tool_call>')).toThrow('TOOL_CALL_INVALID');
  }
});

it('accepts the reported DeepSeek explanation followed by one read request', () => {
  const text = '我来逐步修改这个五子棋demo。首先让我读取当前的文件，确认内容后从最小的样式调整开始。\n<tool_call>{"id":"read_1","tool":"read_file","args":{"path":"index.html"}}</tool_call>';
  expect(parseAssistantTurn(text)).toMatchObject({ kind: 'tool', call: { id: 'read_1', tool: 'read_file' } });
});
it('keeps long fenced source and embedded closing-tag literals intact', () => {
  const content = '<html>' + '中文*下划线_</tool_call>'.repeat(3000) + '</html>';
  const call = { id: 'long', tool: 'write_file', args: { path: 'index.html', content } };
  expect(parseAssistantTurn('我来修改。\n```xml\n<tool_call>' + JSON.stringify(call) + '</tool_call>\n```')).toEqual({ kind: 'tool', call });
});

 it.each(['', '</tool_call', '</tool_call>'])('completes only the missing XML suffix %s', suffix => {
   const call = { id: 'tail', tool: 'bash', args: { cmd: 'echo "<div>"', workspace: 'read' } };
   expect(parseAssistantTurn('<tool_call>' + JSON.stringify(call) + suffix)).toEqual({ kind: 'tool', call });
 });
 it('does not repair truncated JSON or an unterminated command parameter', () => {
   expect(() => parseAssistantTurn('<tool_call>{"id":"tail","tool":"bash","args":{"cmd":"pwd"')).toThrow();
   expect(() => parseAssistantTurn('<tool_calls><invoke name="bash"><parameter name="cmd">pwd')).toThrow();
 });
 it('completes native wrapper closings after a closed parameter', () => {
   expect(parseAssistantTurn('<tool_calls><invoke name="bash"><parameter name="cmd">echo "<div>"</parameter>')).toMatchObject({ kind: 'tool', call: { args: { cmd: 'echo "<div>"', workspace: 'write' } } });
 });

it.each([
  [{ id: 'x', tool: 'bash', args: { cmd: 'pwd' } }, 'args 缺少必填字段：workspace'],
  [{ id: 'x', tool: 'bash', args: { cmd: 'pwd', workspace: 'root' } }, 'args.workspace 必须'],
  [{ id: 'x', tool: 'bash', args: { cmd: 'pwd', workspace: 'read', timeoutMs: 10 } }, 'args.timeoutMs'],
  [{ id: 'x', tool: 'read_file', args: { path: '../secret' } }, 'args.path'],
])('reports the failing field without changing the machine-readable error code', (call, detail) => {
  try { parseAssistantTurn(tool(call)); throw Error('expected parser failure'); }
  catch (error) { expect(error).toMatchObject({ message: 'TOOL_CALL_INVALID', detail: expect.stringContaining(detail) }); }
});
it('reports JSON line and column without quoting potentially sensitive payload text', () => {
  try { parseAssistantTurn('<tool_call>{\n"id":"x",\n"tool":"bash",\n"args": {"cmd":"secret" "workspace":"read"}}</tool_call>'); throw Error('expected failure'); }
  catch (error) { expect(error).toMatchObject({ detail: expect.stringMatching(/JSON 主体第 4 行，第 \d+ 列/) }); expect((error as { detail: string }).detail).not.toContain('secret'); }
});

it('preserves every escaped quote and backslash in a long XML-wrapped JSON payload', async () => {
  const { longToolCall, longToolEnvelope } = await import('../helpers/long-tool-envelope');
  const envelope = longToolEnvelope();
  expect(new TextEncoder().encode(envelope).length).toBeGreaterThan(64 * 1024);
  for (const source of [envelope, '```xml\n' + envelope + '\n```', envelope.replace(/<\/tool_call>$/, '')]) {
    expect(parseAssistantTurn(source)).toEqual({ kind: 'tool', call: longToolCall() });
  }
});
it('diagnoses a broken escaped string late in a long JSON payload', async () => {
  const { longToolEnvelope } = await import('../helpers/long-tool-envelope');
  const broken = longToolEnvelope().replace('value_749', 'value_749"broken');
  try { parseAssistantTurn(broken); throw Error('expected failure'); }
  catch (error) { expect(error).toMatchObject({ message: 'TOOL_CALL_INVALID', detail: expect.stringContaining('JSON 语法错误') }); }
});
