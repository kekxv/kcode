/** Long HTML/JS payload with JSON escapes, literal backslashes and Chinese text. */
export const longToolCall = () => ({
  id: 'long_quotes', tool: 'write_file' as const,
  args: { path: 'index.html', content: '<!DOCTYPE html>\n<html lang="zh-CN"><body>\n'
    + Array.from({ length: 750 }, (_, i) => `<div class="card" data-index="${i}" title="双引号测试"><input value="value_${i}"></div>\n`).join('')
    + '<script>const text = "say \\"hello\\""; const pattern = /\\d+\\s/g; const path = "C:\\\\tmp";</script>\n</body></html>' },
});
export const longToolEnvelope = () => '<tool_call>' + JSON.stringify(longToolCall()) + '</tool_call>';
