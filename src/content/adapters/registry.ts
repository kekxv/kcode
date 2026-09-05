import type { SiteAdapter } from './base';
import { ChatGptAdapter } from './chatgpt';
import { DeepSeekAdapter } from './deepseek';
import { GoogleAiStudioAdapter } from './google-ai-studio';
import { HixAdapter } from './hix';
import { QwenAdapter } from './qwen';

const adapterFactories: Readonly<Record<string, (document: Document) => SiteAdapter>> = {
  'https://chat.deepseek.com': (document) => new DeepSeekAdapter(document),
  'https://chat.qwen.ai': (document) => new QwenAdapter(document),
  'https://aistudio.google.com': (document) => new GoogleAiStudioAdapter(document),
  'https://chatgpt.com': (document) => new ChatGptAdapter(document),
  'https://hix.ai': (document) => new HixAdapter(document),
};

export const adapterForOrigin = (origin: string, document: Document = window.document): SiteAdapter | null =>
  adapterFactories[origin]?.(document) ?? null;
