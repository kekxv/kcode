// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { adapterForOrigin } from '../../../src/content/adapters/registry';

describe('chat adapter registry', () => {
  it.each([
    'https://chat.deepseek.com', 'https://chat.qwen.ai',
    'https://aistudio.google.com', 'https://chatgpt.com', 'https://hix.ai',
    'https://gemini.google.com', 'https://www.easemate.ai',
  ])('creates an adapter only for the exact supported origin %s', (origin) => {
    expect(adapterForOrigin(origin, document)).not.toBeNull();
  });

  it('rejects a spoofed or unsupported origin', () => {
    expect(adapterForOrigin('https://chatgpt.com.evil.example', document)).toBeNull();
  });
});
