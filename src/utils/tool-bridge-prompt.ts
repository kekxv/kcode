/** This describes the extension's text transport, not provider-native function calling. */
export const TOOL_BRIDGE_REMINDER = [
  'kcode uses an external text tool bridge, not ChatGPT/provider-native function calling.',
  'For this task, do not call the chat provider native Python, Code Interpreter, terminal, bash, container, or other execution tools. Those run in a different environment and cannot inspect the kcode workspace.',
  'The /work path belongs to the external kcode VM, not the chat provider sandbox. A missing path or tool in the provider sandbox says nothing about kcode availability.',
  'Write requests in your final visible text response, not in a native tool-call or reasoning channel. Even if a native execution attempt failed, continue by emitting the text request and let kcode report its actual result.',
  'To request an action, write one literal <tool_call> JSON envelope as reply text inside one fenced code block labelled xml, preserving all literal characters. The kcode extension parses it, applies workspace permissions/approvals, executes it in its VM, and sends back <tool_result>.',
  'You do not need a native tool API or direct access to /work to write this request. Do not simulate execution or invent results; wait for <tool_result> before claiming success.',
  'Example request (adapt the tool, arguments and fresh ID to the current goal): <tool_call>{"id":"bridge_read_1","tool":"read_file","args":{"path":"index.html"}}</tool_call>',
].join('\n');

/** Narrowly identifies the native-vs-text transport misunderstanding, not tool execution failures. */
export const reportsMissingNativeTools = (text: string): boolean => {
  const workspaceUnavailable =
    /(?:无法|不能|无法直接|不能直接)访问[^。\n]{0,50}kcode[^。\n]{0,30}(?:工作区|工具)/iu.test(text)
    || /kcode[^。\n]{0,40}(?:工具|工作区)[^。\n]{0,30}(?:不可用|未提供|未连接|无法访问)/iu.test(text)
    || /(?:cannot|can't|unable to) access[^.\n]{0,60}kcode (?:workspace|tools)/i.test(text);
  if (workspaceUnavailable) return true;
  if (!/tool_call|bash|read_file|write_file/i.test(text)) return false;
  return /(?:没有提供|未提供|没有|缺少|未挂载|未启用|无法使用)[^。\n]{0,100}(?:工具接口|工具调用接口|原生工具|工具能力)/u.test(text)
    || /(?:不能|无法)[^。\n]{0,30}(?:发出|调用|使用)[^。\n]{0,60}tool_call/u.test(text)
    || /(?:I (?:do not|don't) have access to|no (?:native )?tools? (?:are )?(?:available|provided)|tools? (?:are|is) not (?:available|provided|enabled))/i.test(text);
};
