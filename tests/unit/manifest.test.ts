import { describe, expect, it } from 'vitest';
import manifest from '../../manifest.json';

describe('manifest', () => {
  it('declares a least-privilege MV3 side panel', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.side_panel.default_path).toBe('src/sidepanel/index.html');
    expect(manifest.permissions).toEqual(['sidePanel', 'storage']);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(manifest.content_scripts[0].matches).toEqual([
      'https://chat.deepseek.com/*', 'https://chat.qwen.ai/*', 'https://aistudio.google.com/*', 'https://chatgpt.com/*', 'https://hix.ai/*',
      'https://gemini.google.com/*', 'https://www.easemate.ai/*',
    ]);
    expect(manifest.content_scripts[0].js).toEqual(['src/content/content-script.ts']);
    expect(manifest).not.toHaveProperty('optional_host_permissions');
    expect(JSON.stringify(manifest)).not.toMatch(/activeTab|"tabs"/);
    expect(manifest.content_security_policy.extension_pages).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  });
});
