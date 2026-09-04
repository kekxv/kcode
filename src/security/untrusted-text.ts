const CONTROL_TOKEN = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

const isInvisibleOrBidi = (codePoint: number): boolean =>
  (codePoint >= 0x200b && codePoint <= 0x200f)
  || (codePoint >= 0x202a && codePoint <= 0x202e)
  || (codePoint >= 0x2060 && codePoint <= 0x2069)
  || codePoint === 0xfeff;

/** Makes hidden and directional controls visible before commands or paths are presented for approval. */
export const visualizeControls = (value: string): string => Array.from(value, (character) => {
  const codePoint = character.codePointAt(0)!;
  if (codePoint === 0 || isInvisibleOrBidi(codePoint)) return CONTROL_TOKEN(codePoint);
  if ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    || (codePoint >= 0x7f && codePoint <= 0x9f)) return CONTROL_TOKEN(codePoint);
  return character;
}).join('');

type EscapeState = 'text' | 'esc' | 'csi' | 'string' | 'string-esc';

/**
 * Stateful terminal escape filter. It retains only CSI SGR (color/reset)
 * sequences and consumes OSC/DCS/APC/PM controls, including controls split
 * over two incoming worker chunks.
 */
export class TerminalChunkSanitizer {
  private state: EscapeState = 'text';
  private csi = '';

  write(chunk: string): string {
    let safe = '';
    for (const character of chunk) {
      switch (this.state) {
        case 'text':
          if (character === '\u001b') this.state = 'esc';
          else if (character !== '\u009b' && character !== '\u0090' && character !== '\u009d' && character !== '\u009f' && character !== '\u009e') safe += character;
          break;
        case 'esc':
          if (character === '[') {
            this.csi = '\u001b[';
            this.state = 'csi';
          } else if (character === ']' || character === 'P' || character === '_' || character === '^') {
            this.state = 'string';
          } else if (character === '\u001b') {
            this.state = 'esc';
          } else {
            this.state = 'text';
          }
          break;
        case 'csi':
          this.csi += character;
          if (character >= '@' && character <= '~') {
            if (/^\u001b\[[0-9;]*m$/.test(this.csi)) safe += this.csi;
            this.csi = '';
            this.state = 'text';
          } else if (this.csi.length > 128) {
            this.csi = '';
            this.state = 'text';
          }
          break;
        case 'string':
          if (character === '\u0007') this.state = 'text';
          else if (character === '\u001b') this.state = 'string-esc';
          break;
        case 'string-esc':
          this.state = character === '\\' ? 'text' : character === '\u001b' ? 'string-esc' : 'string';
          break;
      }
    }
    return safe;
  }
}

/** Filters one complete terminal chunk. Use TerminalChunkSanitizer for streaming worker output. */
export const sanitizeTerminalChunk = (chunk: string): string => new TerminalChunkSanitizer().write(chunk);
