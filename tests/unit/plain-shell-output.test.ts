import { expect, it } from 'vitest';
import { plainShellOutput } from '../../src/utils/plain-shell-output';
it('strips color, cursor, mode and OSC sequences but preserves content', () => {
  expect(plainShellOutput('\x1b[?25l\x1b[2K\x1b[31mindex.html\x1b[m\r\n\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'))
    .toBe('index.html\nlink');
});
it('keeps ordinary bracketed text and printable control notation intact', () => {
  expect(plainShellOutput('[0;0m literal U+001B and \\u001b[31m')).toBe('[0;0m literal U+001B and \\u001b[31m');
});
it('drops device control payloads and incomplete OSC payloads', () => {
  expect(plainShellOutput('a\x1bPsecret\x1b\\b\x1b]52;c;secret')).toBe('ab');
});
