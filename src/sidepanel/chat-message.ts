import type { ImageAttachment } from '../types/attachments';
import type { LocalToolResult, ToolCall } from '../types/tools';

export type ChatMessage = {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  result?: LocalToolResult;
  images?: ImageAttachment[];
  tool?: ToolCall;
  status?: 'approval' | 'running' | 'review' | 'release' | 'done' | 'failed' | 'cancelled';
};

/** Keep tool protocol (including incomplete streaming prefixes) out of prose bubbles. */
export const assistantProse = (text: string): string => {
  const index = text.search(/<\/?tool_call(?:\b|_)/);
  const prose = index < 0 ? text : text.slice(0, index);
  return prose.replace(/(?:```(?:json|xml)?\s*)?<(?:t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?)?$/i, '').replace(/```(?:json|xml)?\s*$/, '').trimEnd();
};
