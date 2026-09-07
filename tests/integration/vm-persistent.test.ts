import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.env.KCODE_VM_TEST !== '1')('real persistent VM', () => {
  it('writes through FSA and keeps cwd/env across clean serial results', async () => {
    await build();
    const assets = await fs.readdir('dist/assets');
    const workerFile = assets.find(name => /^vm\.worker-.*\.js$/.test(name))!;
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html></html>'); return; }
        const path = join(process.cwd(), 'dist', new URL(req.url!, 'http://localhost').pathname);
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        res.end(await fs.readFile(path));
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const browser = await chromium.launch({ headless: true, ...(process.env.KCODE_CHROME_PATH ? { executablePath: process.env.KCODE_CHROME_PATH } : {}) });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const results = await page.evaluate(async workerFile => {
        const directory = await navigator.storage.getDirectory();
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('kcode', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('workspace');
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('workspace', 'readwrite');
          tx.objectStore('workspace').put({ workspaceId: 'workspace-1', handle: directory }, 'selected-directory');
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
        db.close();
        const worker = new Worker(`/assets/${workerFile}`, { type: 'module' });
        let sequence = 0;
        const request = (body: Record<string, unknown>, onOutput?: (text: string, requestId: string) => void): Promise<Record<string, any>> => new Promise((resolve, reject) => {
          const requestId = `request_${++sequence}`;
          let output = '';
          const timer = setTimeout(() => reject(new Error(`TIMEOUT:${body.kind}`)), 60000);
          worker.onmessage = ({ data }) => {
            if (data.requestId === requestId && data.kind === 'VM_OUTPUT_DELTA') { output += data.delta; onOutput?.(output, requestId); return; }
            if (data.requestId !== requestId || ['VM_HEARTBEAT', 'VM_OUTPUT_DELTA'].includes(data.kind)) return;
            clearTimeout(timer);
            if (data.kind === 'VM_ERROR') reject(new Error(JSON.stringify({ ...data, output }))); else resolve(data);
          };
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.postMessage({ ...body, requestId });
        });
        const session = { mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read', 'write'], network: { mode: 'offline' } };
        try {
          await request({ kind: 'VM_INIT', session, persistent: true });
          await request({ kind: 'VM_ATTACH_WORKSPACE', handle: directory });
          await request({ kind: 'VM_BEGIN_TRANSACTION', transactionId: 'tx_write' });
          const write = await request({ kind: 'VM_WRITE_FILE', path: 'index.html', content: '<html lang="zh-CN">你好</html>' });
          await request({ kind: 'VM_COMMIT_TRANSACTION' });
          const actual = await (await directory.getFileHandle('index.html')).getFile();
          await request({ kind: 'VM_UPDATE_SESSION', session: { ...session, capabilities: ['read'] } });
          const first = await request({ kind: 'VM_EXEC', command: 'cat /work/index.html; cd /tmp; export DEMO_CONTEXT=preserved; printf "\\nfirst\\n"', timeoutMs: 30000 });
          const second = await request({ kind: 'VM_EXEC', command: 'pwd; printf "%s\\n" "$DEMO_CONTEXT"; false', timeoutMs: 30000 });
          const read = await request({ kind: 'VM_READ_FILE', path: 'index.html', maxBytes: 1024 });
          const input = (targetRequestId: string, data: string) => worker.postMessage({ kind: 'VM_STDIN', requestId: 'input_' + (++sequence), targetRequestId, data });
          let answered = false;
          const interactiveRead = await request({ kind: 'VM_EXEC', command: 'printf "NAME?"; read answer; printf "Hello:%s\\n" "$answer"', timeoutMs: 30000 }, (output, id) => {
            if (!answered && output.includes('NAME?')) { answered = true; input(id, 'Ada你好\r'); }
          });
          let pythonStage = 0;
          const python = await request({ kind: 'VM_EXEC', command: 'python3 -q', timeoutMs: 30000 }, (output, id) => {
            if (pythonStage === 0 && output.includes('>>> ')) { pythonStage++; input(id, 'print(6*7)\r'); }
            else if (pythonStage === 1 && /\r?\n42\r?\n/.test(output)) { pythonStage++; input(id, '\x04'); }
          });
          let interrupted = false;
          const interrupt = await request({ kind: 'VM_EXEC', command: 'printf "WAITING"; sleep 30', timeoutMs: 30000 }, (output, id) => {
            if (!interrupted && output.includes('WAITING')) { interrupted = true; setTimeout(() => input(id, '\x03'), 200); }
          });
          const afterInterrupt = await request({ kind: 'VM_EXEC', command: 'printf "%s" "$DEMO_CONTEXT"', timeoutMs: 30000 });
          let editing = false;
          const vi = await request({ kind: 'VM_EXEC', command: 'TERM=xterm vi /tmp/interactive.txt', timeoutMs: 30000 }, (output, id) => {
            if (!editing && output.includes('~')) { editing = true; void (async () => {
              for (const keys of ['i', 'hello-from-vm', '\x1b', ':wq\r']) {
                await new Promise(resolve => setTimeout(resolve, 250)); input(id, keys);
              }
            })(); }
          });
          const edited = await request({ kind: 'VM_EXEC', command: 'cat /tmp/interactive.txt', timeoutMs: 30000 });
          return { write, actual: await actual.text(), first, second, read, interactiveRead, python, interrupt, afterInterrupt, vi, edited };
        } finally { worker.terminate(); }
      }, workerFile);
      expect(Number.isInteger(results.write.durationMs)).toBe(true);
      expect(results.actual).toBe('<html lang="zh-CN">你好</html>');
      expect(results.read.text).toBe(results.actual);
      expect(results.first.output).toContain(results.actual);
      expect(results.first.exitCode).toBe(0);
      expect(results.second.output.replaceAll('\r', '')).toBe('/tmp\npreserved\n');
      expect(results.second.exitCode).toBe(1);
      expect(results.first.output).not.toMatch(/KCODE_|base64|Read-only|none\):/);
      expect(results.interactiveRead.output).toContain('Hello:Ada你好');
      expect(results.python.output).toMatch(/\r?\n42\r?\n/);
      expect(results.python.exitCode).toBe(0);
      expect(results.interrupt.durationMs).toBeLessThan(5000);
      expect(results.afterInterrupt.output).toBe('preserved');
      expect(results.vi.exitCode).toBe(0);
      expect(results.edited.output).toContain('hello-from-vm');
    } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 180000);
});
