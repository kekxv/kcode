import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.env.KCODE_BROWSER_TEST !== '1')('xterm with extension CSP', () => {
  it('renders, resizes and switches themes without blocked styles', async () => {
    const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
    const server = await createServer({
      configFile: false,
      server: { host: '127.0.0.1', port: 0, hmr: false },
      plugins: [{
        name: 'terminal-csp-fixture',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url === '/terminal-review') {
              res.setHeader('Content-Type', 'text/html');
              res.setHeader('Content-Security-Policy', manifest.content_security_policy.extension_pages);
              res.end('<div id="terminal" style="width:600px;height:300px"></div><script type="module" src="/terminal-harness.js"></script>');
            } else if (req.url === '/terminal-harness.js') {
              res.setHeader('Content-Type', 'text/javascript');
              res.end(`import { TerminalManager } from '/src/sidepanel/terminal-manager.ts';
                import '/node_modules/@xterm/xterm/css/xterm.css';
                window.terminal = new TerminalManager(undefined, true);
                window.terminal.mount(document.querySelector('#terminal'));
                window.terminal.write('hello CSP\\r\\n');
              `);
            } else next();
          });
        },
      }],
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true, ...(process.env.KCODE_CHROME_PATH ? { executablePath: process.env.KCODE_CHROME_PATH } : {}) });
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        (window as any).styleViolations = [];
        document.addEventListener('securitypolicyviolation', event => {
          if (event.effectiveDirective.startsWith('style-src')) (window as any).styleViolations.push(event.blockedURI);
        });
      });
      const address = server.httpServer!.address() as { port: number };
      await page.goto(`http://127.0.0.1:${address.port}/terminal-review`);
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('hello CSP'));
      const before = await page.evaluate(() => (window as any).terminal.size().cols);
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('#terminal')!.style.width = '300px';
        (window as any).terminal.setTheme('light');
        (window as any).terminal.write('\x1b[31mred\x1b[0m');
      });
      await page.waitForFunction(cols => (window as any).terminal.size().cols < cols, before);
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('red'));
      await page.evaluate(() => (window as any).terminal.setTheme('dark'));
      expect(await page.evaluate(() => (window as any).styleViolations)).toEqual([]);
      expect(await page.locator('.xterm-screen').evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
    } finally { await browser.close(); await server.close(); }
  }, 45000);
});
