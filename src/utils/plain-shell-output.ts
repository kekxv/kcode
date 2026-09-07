/** Convert completed shell output to text before secret scanning and model release.
 * Terminal rendering uses the original stream; file reads never pass through here.
 */
export const plainShellOutput = (text: string): string => text
  // OSC (titles/hyperlinks/clipboard) and DCS/SOS/PM/APC payloads.
  .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
  .replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
  // CSI includes colors, cursor motion, erase and terminal mode switches.
  .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[ -/]*[@-Z\\-_]/g, '')
  .replace(/\r\n/g, '\n');
