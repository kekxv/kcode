import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const expectedCsp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const manifestPath = resolve(process.argv[2] ?? 'manifest.json');

const fail = (message) => { throw new Error(`SECURITY_SOURCE_SCAN: ${message}`); };
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (JSON.stringify(manifest).match(/"tabs"|"activeTab"/)) fail('forbidden manifest permission');
if ('optional_host_permissions' in manifest) fail('optional_host_permissions is forbidden');
if (JSON.stringify(manifest.permissions) !== JSON.stringify(['sidePanel', 'storage'])) fail('permissions contract changed');
const expectedContentHosts = [
  'https://chat.deepseek.com/*', 'https://chat.qwen.ai/*',
  'https://aistudio.google.com/*', 'https://chatgpt.com/*',
  'https://hix.ai/*', 'https://gemini.google.com/*',
];
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['<all_urls>'])) fail('host permission contract changed');
if (manifest.content_security_policy?.extension_pages !== expectedCsp) fail('extension CSP contract changed');
if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1
  || JSON.stringify(manifest.content_scripts[0].matches) !== JSON.stringify(expectedContentHosts)) fail('content script scope changed');

const dangerous = [
  ['v-html', /v-html\b/], ['innerHTML', /\.innerHTML\b/], ['outerHTML', /\.outerHTML\b/],
  ['insertAdjacentHTML', /insertAdjacentHTML\b/], ['eval', /\beval\s*\(/], ['Function constructor', /new\s+Function\b/],
  ['dynamic script element', /createElement\(\s*['"]script['"]\s*\)/], ['generic fetch bridge', /\bfetch\s*\(/],
  ['application WebSocket', /new\s+WebSocket\b/],
];
const sourceFiles = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:ts|vue)$/u.test(entry.name)) sourceFiles.push(path);
  }
};
await walk(resolve('src'));
for (const path of sourceFiles) {
  const text = await readFile(path, 'utf8');
  for (const [name, pattern] of dangerous) if (pattern.test(text)) fail(`${name} in ${path}`);
  if (/chrome\.storage\.local\.(?:set|remove)\([^)]*risk-consent/iu.test(text)) fail(`durable risk consent storage in ${path}`);
  if (/indexedDB/iu.test(text) && /RiskConsent/u.test(text)) fail(`IndexedDB risk consent storage in ${path}`);
}

if (process.argv[2]) await stat(manifestPath);
process.stdout.write(`security source scan passed (${sourceFiles.length} source files)\n`);
