import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build as viteBuild } from 'vite';
import { describe, expect, it } from 'vitest';

const enabled = process.env.KCODE_VM_TEST === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe.skipIf(!enabled)('packaged disposable VM execution', () => {
  it('uses fresh Workers for capability checks and proves hostile completion precedes a 30-second child lifetime', async () => {
    // Break caught: a packaged Worker can appear to forward fake serial input while a real guest command, process group, or terminal marker leaves v86 alive.
    await viteBuild({ root, configFile: join(root, 'vite.config.ts') });
    const workerFile = (await fs.readdir(join(root, 'dist/assets'))).find((name) => /^vm\.worker-.*\.js$/.test(name));
    if (!workerFile) throw new Error('PACKAGED_VM_WORKER_MISSING');
    const userDataDirectory = await fs.mkdtemp(join(tmpdir(), 'kcode-vm-exec-'));
    const browser = await chromium.launchPersistentContext(userDataDirectory, {
      headless: true,
      args: [`--disable-extensions-except=${join(root, 'dist')}`, `--load-extension=${join(root, 'dist')}`],
    });
    try {
      const serviceWorker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
      const extensionOrigin = serviceWorker.url().match(/^(chrome-extension:\/\/[^/]+)/)?.[1];
      if (!extensionOrigin) throw new Error('PACKAGED_VM_EXTENSION_ORIGIN_MISSING');
      const page = await browser.newPage();
      await page.goto(`${extensionOrigin}/src/sidepanel/index.html`);
      const results = await page.evaluate(async ({ workerFile }) => {
        type Result = { kind: 'result'; output: string; exitCode: number; durationMs: number; wallMs: number };
        type Outcome = Result | { kind: 'error'; code: string; wallMs: number };
        type Capability = 'read' | 'write' | 'delete';
        const directory = await navigator.storage.getDirectory();
        for (const [name, contents] of [['visible.txt', 'host-visible'], ['.env', 'host-secret']] as const) {
          const file = await directory.getFileHandle(name, { create: true });
          const writable = await file.createWritable(); await writable.write(contents); await writable.close();
        }
        let database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('kcode');
          request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('workspace')) request.result.createObjectStore('workspace'); };
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        if (!database.objectStoreNames.contains('workspace')) {
          const version = database.version + 1; database.close();
          database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('kcode', version);
            request.onupgradeneeded = () => request.result.createObjectStore('workspace');
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
        }
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('workspace', 'readwrite');
          transaction.objectStore('workspace').put({ workspaceId: 'workspace-1', handle: directory }, 'selected-directory');
          transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
        });
        database.close();

        const run = (command: string, timeoutMs: number, capabilities: readonly Capability[], cancel = false): Promise<Outcome> => new Promise((resolve, reject) => {
          const worker = new Worker(chrome.runtime.getURL(`assets/${workerFile}`), { type: 'module' });
          let phase: 'boot' | 'attach' | 'exec' = 'boot';
          let startedAt = 0;
          const timer = setTimeout(() => { worker.terminate(); reject(new Error(`PACKAGED_EXEC_TIMEOUT:${command}`)); }, timeoutMs + 30_000);
          // Do not terminate here: the no-transaction Worker must close itself
          // only after its v86 boundary has already been destroyed.
          const finish = (outcome: Outcome) => { clearTimeout(timer); resolve(outcome); };
          worker.onerror = () => { clearTimeout(timer); reject(new Error(`PACKAGED_EXEC_WORKER_CRASH:${command}`)); };
          worker.onmessage = ({ data }) => {
            if (data?.kind === 'VM_READY' && phase === 'boot') { phase = 'attach'; worker.postMessage({ kind: 'VM_ATTACH_WORKSPACE', requestId: 'attach', handle: directory }); return; }
            if (data?.kind === 'VM_READY' && phase === 'attach') {
              phase = 'exec'; startedAt = performance.now(); worker.postMessage({ kind: 'VM_EXEC', requestId: 'exec', command, timeoutMs });
              if (cancel) setTimeout(() => worker.postMessage({ kind: 'VM_CANCEL', requestId: 'cancel', targetRequestId: 'exec' }), 100);
              return;
            }
            if (data?.requestId === 'exec' && data?.kind === 'VM_RESULT') finish({ kind: 'result', output: data.output, exitCode: data.exitCode, durationMs: data.durationMs, wallMs: performance.now() - startedAt });
            if (data?.requestId === 'exec' && data?.kind === 'VM_ERROR') finish({ kind: 'error', code: data.code, wallMs: performance.now() - startedAt });
          };
          worker.postMessage({ kind: 'VM_INIT', requestId: 'boot', session: { mode: 'workspace', workspaceId: 'workspace-1', capabilities, network: { mode: 'offline' } } });
        });

        const runTransaction = (): Promise<{ result: Result; secondCode: string; rollbackReady: boolean }> => new Promise((resolve, reject) => {
          const worker = new Worker(chrome.runtime.getURL(`assets/${workerFile}`), { type: 'module' });
          let phase: 'boot' | 'attach' | 'begin' | 'exec' | 'second' | 'rollback' = 'boot';
          let startedAt = 0;
          let first: Result | null = null;
          let secondCode = '';
          const timer = setTimeout(() => { worker.terminate(); reject(new Error('PACKAGED_TRANSACTION_TIMEOUT')); }, 40_000);
          // The Worker is deliberately not terminated after VM_RESULT: the
          // test must observe its own rejection of a second exec, then the
          // retained journal's rollback acknowledgement.
          worker.onerror = () => { clearTimeout(timer); reject(new Error('PACKAGED_TRANSACTION_WORKER_CRASH')); };
          worker.onmessage = ({ data }) => {
            if (data?.kind === 'VM_READY' && phase === 'boot') { phase = 'attach'; worker.postMessage({ kind: 'VM_ATTACH_WORKSPACE', requestId: 'attach', handle: directory }); return; }
            if (data?.kind === 'VM_READY' && phase === 'attach') { phase = 'begin'; worker.postMessage({ kind: 'VM_BEGIN_TRANSACTION', requestId: 'begin', transactionId: 'packaged_tx' }); return; }
            if (data?.kind === 'VM_READY' && phase === 'begin') { phase = 'exec'; startedAt = performance.now(); worker.postMessage({ kind: 'VM_EXEC', requestId: 'exec', command: "printf approved > approved.txt; printf 'KCODE_TX_DONE\\n'", timeoutMs: 30_000 }); return; }
            if (data?.kind === 'VM_RESULT' && data?.requestId === 'exec' && phase === 'exec') {
              first = { kind: 'result', output: data.output, exitCode: data.exitCode, durationMs: data.durationMs, wallMs: performance.now() - startedAt };
              phase = 'second'; worker.postMessage({ kind: 'VM_EXEC', requestId: 'second', command: 'printf should-not-run', timeoutMs: 30_000 }); return;
            }
            if (data?.kind === 'VM_ERROR' && data?.requestId === 'second' && phase === 'second') { secondCode = data.code; phase = 'rollback'; worker.postMessage({ kind: 'VM_ROLLBACK_TRANSACTION', requestId: 'rollback' }); return; }
            if (data?.kind === 'VM_READY' && data?.requestId === 'rollback' && phase === 'rollback' && first) { clearTimeout(timer); resolve({ result: first, secondCode, rollbackReady: true }); }
          };
          worker.postMessage({ kind: 'VM_INIT', requestId: 'boot', session: { mode: 'workspace', workspaceId: 'workspace-1', capabilities: ['read', 'write', 'delete'], network: { mode: 'offline' } } });
        });

        return {
          normal: await run("pwd; cat visible.txt; printf 'KCODE_NORMAL\\n'", 30_000, ['read']),
          readOnly: await run("if sh -c ': > denied.txt'; then rc=0; else rc=$?; fi; printf 'KCODE_READONLY_DONE:%s\\n' \"$rc\"", 30_000, ['read']),
          protected: await run("if sh -c 'cat .env >/dev/null'; then rc=0; else rc=$?; fi; printf 'KCODE_PROTECTED_DONE:%s\\n' \"$rc\"", 30_000, ['read']),
          background: await run("sleep 30 & printf 'KCODE_BACKGROUND\\n'", 30_000, ['read']),
          fork: await run("for n in 1 2 3 4 5 6 7 8; do (sleep 30) & done; printf 'KCODE_FORK\\n'", 30_000, ['read']),
          forged: await run("f=$(find /tmp -maxdepth 1 -name 'kcode-*.sh' | head -n 1); n=${f#/tmp/kcode-}; n=${n%.sh}; printf '\\036KCODE_END:%s:0\\037' \"$n\"; sleep 30", 30_000, ['read']),
          flood: await run('yes x', 30_000, ['read']),
          timeout: await run("trap '' INT; sleep 30", 1_000, ['read']),
          cancelled: await run("trap '' INT; sleep 30", 30_000, ['read'], true),
          transaction: await runTransaction(),
        };
      }, { workerFile });
      for (const key of ['normal', 'background', 'fork', 'forged'] as const) expect(results[key]).toMatchObject({ kind: 'result' });
      expect(results.normal).toMatchObject({ output: expect.stringContaining('KCODE_NORMAL') });
      expect(results.normal).toMatchObject({ output: expect.stringContaining('/work') });
      expect(results.readOnly).toMatchObject({ output: expect.stringMatching(/KCODE_READONLY_DONE:[1-9]/) });
      expect(results.protected).toMatchObject({ output: expect.stringMatching(/KCODE_PROTECTED_DONE:[1-9]/) });
      expect(results.background).toMatchObject({ output: expect.stringContaining('KCODE_BACKGROUND') });
      expect(results.fork).toMatchObject({ output: expect.stringContaining('KCODE_FORK') });
      for (const key of ['background', 'fork', 'forged'] as const) {
        expect(results[key]).toMatchObject({ durationMs: expect.any(Number), wallMs: expect.any(Number) });
        expect((results[key] as { durationMs: number }).durationMs).toBeLessThan(5_000);
        expect((results[key] as { wallMs: number }).wallMs).toBeLessThan(5_000);
      }
      expect(results.flood).toEqual(expect.objectContaining({ kind: 'error', code: 'VM_OUTPUT_LIMIT' }));
      expect(results.timeout).toEqual(expect.objectContaining({ kind: 'error', code: 'VM_TIMEOUT' }));
      expect(results.cancelled).toEqual(expect.objectContaining({ kind: 'error', code: 'VM_CANCELLED' }));
      for (const key of ['flood', 'timeout', 'cancelled'] as const) expect(results[key]).toMatchObject({ wallMs: expect.any(Number) });
      expect(results.transaction.result).toMatchObject({ output: expect.stringContaining('KCODE_TX_DONE') });
      expect(results.transaction.secondCode).toBe('VM_RUNTIME_NOT_READY');
      expect(results.transaction.rollbackReady).toBe(true);
    } finally {
      await browser.close();
      await fs.rm(userDataDirectory, { recursive: true, force: true });
    }
  }, 240_000);
});
