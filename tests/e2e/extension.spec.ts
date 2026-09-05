import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, chromium, type BrowserContext } from 'playwright/test';

const extensionPath = resolve('dist');

test('loads the packaged extension and renders the safe initial side panel', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kcode-chromium-profile-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [
        '--disable-crashpad', '--disable-crash-reporter', '--noerrdialogs',
        `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      ],
    });
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);

    await expect(page.getByRole('region', { name: '运行状态' })).toContainText('执行：confirm-each');
    await expect(page.getByRole('region', { name: '运行状态' })).toContainText('网络：offline');
    await expect(page.getByRole('button', { name: '选择工作目录' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'VM 内存' })).toHaveValue('standard');
    await expect(page.getByRole('textbox', { name: '自定义 Agent 指令' })).toBeVisible();
    await expect(page.getByRole('region', { name: '安全终端' })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始任务' })).toBeDisabled();
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('packages content scripts only for the supported chat origins', async () => {
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8')) as {
    host_permissions: string[];
    content_scripts: Array<{ matches: string[] }>;
  };
  const expected = [
    'https://chat.deepseek.com/*', 'https://chat.qwen.ai/*',
    'https://aistudio.google.com/*', 'https://chatgpt.com/*',
    'https://hix.ai/*', 'https://gemini.google.com/*', 'https://www.easemate.ai/*',
  ];
  expect(manifest.host_permissions).toEqual(['<all_urls>']);
  expect(manifest.content_scripts[0]?.matches).toEqual(expected);
});

test('packages the background router in the service worker entry', async () => {
  // Break caught: content and background entries sharing `index.ts` make the generated service-worker loader import the content script.
  const loader = await readFile(join(extensionPath, 'service-worker-loader.js'), 'utf8');
  const asset = loader.match(/\.\/assets\/([^']+)/)?.[1];
  expect(asset).toBeTruthy();
  const worker = await readFile(join(extensionPath, 'assets', asset!), 'utf8');
  expect(worker).toContain('setPanelBehavior');
  expect(worker).toContain('onConnect.addListener');
});
