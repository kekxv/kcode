import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { sanitizeTerminalChunk, TerminalChunkSanitizer, visualizeControls } from '../../src/security/untrusted-text';
import { TerminalManager } from '../../src/sidepanel/terminal-manager';

describe('untrusted text defenses', () => {
  it('renders hostile controls as literal text and removes every forbidden OSC sequence', () => {
    // Break caught: a terminal sanitizer that lets a link, clipboard write, or title escape through.
    const hostile = '<img src=x onerror=alert(1)> javascript:alert(1)\u202E'
      + '\u001b]8;;https://evil.example\u0007click\u001b]8;;\u001b\\'
      + '\u001b]52;c;YWJ1cw==\u0007\u001b]2;stolen title\u001b\\';

    expect(sanitizeTerminalChunk(hostile)).toBe('<img src=x onerror=alert(1)> javascript:alert(1)\u202Eclick');
    expect(visualizeControls('rm\u0000 -rf\u200b /\u202E')).toBe('rmU+0000 -rfU+200B /U+202E');
  });

  it('preserves basic SGR formatting while stripping DCS, APC, and PM payloads', () => {
    // Break caught: stripping all escapes loses terminal colors; keeping string-control payloads is unsafe.
    expect(sanitizeTerminalChunk('\u001b[31mred\u001b[0m\u001bPsecret\u001b\\\u001b_payload\u001b\\\u001b^hidden\u001b\\'))
      .toBe('\u001b[31mred\u001b[0m');
  });

  it('keeps only CR/LF among C0 controls and strips every C1 control', () => {
    // Break caught: BEL, backspace, IND, or RI can still alter the terminal after sanitization.
    expect(sanitizeTerminalChunk('one\u0007\u0008\u0009\n\rtwo\u0084\u008dthree')).toBe('one\n\rtwothree');
  });

  it('removes complete 8-bit OSC, DCS, APC, and PM payloads', () => {
    // Break caught: stripping only a C1 introducer leaves title or string-control payload text in terminal output.
    const hostile = 'safe\u009d2;title\u0007osc\u0090secret\u001b\\dcs\u009fapc\u001b\\apc\u009epm\u001b\\done';
    expect(sanitizeTerminalChunk(hostile)).toBe('safeoscdcsapcdone');
  });

  it('ends 8-bit control strings at C1 ST, including when split across chunks', () => {
    // Break caught: C1 ST is consumed as payload, so later printable output disappears from the terminal.
    expect(sanitizeTerminalChunk('\u0090secret\u009cafter')).toBe('after');
    const sanitizer = new TerminalChunkSanitizer();
    expect(sanitizer.write('\u009dtitle\u009c')).toBe('');
    expect(sanitizer.write('after')).toBe('after');
  });
});

describe('TerminalManager', () => {
  it('batches sanitized terminal chunks and disposes its terminal', () => {
    // Break caught: unsafe controls reach xterm or output is written unbounded per event.
    vi.useFakeTimers();
    const terminal = { open: vi.fn(), write: vi.fn(), dispose: vi.fn() };
    const manager = new TerminalManager(() => terminal);
    manager.mount({} as HTMLElement);
    manager.write('\u001b]52;c;YWJ1cw==\u0007safe');
    manager.write('\u001b[32m green\u001b[0m');
    vi.advanceTimersByTime(50);
    expect(terminal.write).toHaveBeenCalledWith('safe\u001b[32m green\u001b[0m');
    manager.dispose();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
