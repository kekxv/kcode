import { describe, expect, it } from 'vitest';
import { assistantProse } from '../../src/sidepanel/chat-message';

describe('assistant protocol hiding', () => {
  it.each(['<tool_call>', '<tool_call id="call_1">', '<tool_call_to_1>', '<tool_call_bash>'])('hides %s while retaining explanatory prose', tag => {
    const text = '我来创建 HTML。' + tag + '{"id":"call_5","tool":"write_file"';
    expect(assistantProse(text)).toBe('我来创建 HTML。');
  });
  it('hides every incomplete streaming prefix', () => {
    const tag = '<tool_call>';
    for (let i = 1; i <= tag.length; i++) expect(assistantProse('说明。' + tag.slice(0, i))).toBe('说明。');
  });
});
