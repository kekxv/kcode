import { mkdtemp, rm } from 'node:fs/promises';
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
    await expect(page.getByRole('region', { name: '安全终端' })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始任务' })).toBeDisabled();
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
