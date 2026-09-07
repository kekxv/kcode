import { vi } from 'vitest';
import { adapterForOrigin } from '../../src/content/adapters/registry';
import deepSeekComposer from '../fixtures/deepseek-current-composer.html?raw';
import { ContentController } from '../../src/content';
import { PortRouter } from '../../src/background/port-router';
import { TabClient } from '../../src/sidepanel/tab-client';
import { ToolDispatcher } from '../../src/sidepanel/tool-dispatcher';
import { AgentOrchestrator } from '../../src/sidepanel/agent-orchestrator';
import { authorizationForTool, type AgentOutcome, type ToolCall } from '../../src/types/tools';

export type QwenTurn = {
  snapshots: string[];
  remount?: boolean;
  stop?: 'remove' | 'hidden' | 'relabel' | 'stall';
};

/** Scripted DOM provider; all production layers between the DOM and VM run unchanged. */
export const createQwenSimulation = (turns: QwenTurn[], approve = true, provider: 'Qwen' | 'DeepSeek' = 'Qwen') => {
  const prompts: string[] = [];
  const events: Array<{ kind: string; code?: string }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const origin = provider === 'Qwen' ? 'https://chat.qwen.ai' : 'https://chat.deepseek.com';
  const href = { href: `${origin}/` };
  document.body.innerHTML = '<main><div class="message-input-container"><textarea class="message-input-textarea"></textarea><button class="send-button" aria-label="Send">Send</button></div><section class="answers"></section></main>';
  if (provider === 'DeepSeek') document.body.innerHTML = deepSeekComposer;
  const visible = () => {
    for (const node of document.querySelectorAll('body, main, textarea, button, div')) {
      Object.defineProperty(node, 'getClientRects', { configurable: true, value: () => [{ width: 1, height: 1 }] });
    }
  };
  visible();
  const later = (callback: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
    timers.add(timer);
  };
  const unexpectedPrompts: string[] = [];
  const onSend = (event: Event) => {
    const sendSelector = provider === 'Qwen' ? '.send-button' : '.ds-button--primary.ds-button--circle:not(.ds-button--disabled)';
    if (!(event.target instanceof Element) || !event.target.matches(sendSelector)) return;
    const prompt = document.querySelector('textarea')!.value;
    const turn = turns[prompts.length];
    prompts.push(prompt);
    if (!turn) { unexpectedPrompts.push(prompt); return; }
    href.href = `${origin}/c/simulation-${prompts.length}`;
    if (turn.remount) {
      const main = document.querySelector(provider === 'Qwen' ? 'main' : '#app')!;
      main.replaceWith(main.cloneNode(true));
      visible();
    }
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', 'Stop');
    const deepSeekSend = document.querySelector('.ds-button--circle');
    const deepSeekArrow = deepSeekSend?.querySelector('path');
    const arrowPath = deepSeekArrow?.getAttribute('d');
    if (provider === 'Qwen') document.querySelector('.message-input-container')!.append(stop);
    else deepSeekArrow?.removeAttribute('d'); // Model an unlabelled generating control.
    visible();
    let answer = document.createElement('div');
    answer.className = provider === 'Qwen' ? 'response-message-content phase-answer' : 'ds-markdown';
    document.querySelector('.answers')!.append(answer);
    turn.snapshots.forEach((snapshot, index) => later(() => {
      // Qwen replaces answer subtrees, not just append-only text nodes.
      const next = answer.cloneNode(false) as HTMLDivElement;
      next.textContent = snapshot;
      answer.replaceWith(next);
      answer = next;
    }, (index + 1) * 100));
    if (turn.stop !== 'stall') later(() => {
      if (provider === 'DeepSeek') {
        deepSeekArrow?.setAttribute('d', arrowPath!);
        deepSeekSend?.classList.add('ds-button--disabled');
        document.querySelector('textarea')!.value = '';
      } else if (turn.stop === 'hidden') stop.hidden = true;
      else if (turn.stop === 'relabel') stop.setAttribute('aria-label', 'Finished');
      else stop.remove();
    }, (turn.snapshots.length + 1) * 100);
  };
  const onInput = () => {
    if (provider === 'DeepSeek') later(() => document.querySelector('.ds-button--circle')?.classList.remove('ds-button--disabled'), 75);
  };
  document.addEventListener('input', onInput);
  document.addEventListener('click', onSend);

  let receivePanel: (message: unknown) => void = () => {};
  let receiveContent: (message: unknown) => void = () => {};
  const router = new PortRouter({ tabs: { get: async () => ({ id: 7, url: href.href } as chrome.tabs.Tab) } });
  const routerPanel = { name: 'kcode-sidepanel', postMessage: (message: unknown) => receivePanel(message) };
  const routerContent = { name: 'kcode-content', sender: { tab: { id: 7 }, url: href.href }, postMessage: (message: unknown) => receiveContent(message) };
  router.setSidePanelPort(routerPanel as chrome.runtime.Port);
  router.setContentPort(routerContent as chrome.runtime.Port);
  const client = new TabClient(() => ({
    name: 'kcode-sidepanel',
    postMessage: (message: unknown) => { void router.fromSidePanel(message); },
    onMessage: { addListener: (listener: typeof receivePanel) => { receivePanel = listener; } },
    onDisconnect: { addListener: () => {} }, disconnect: () => {},
  }) as unknown as chrome.runtime.Port);
  const controller = new ContentController({
    name: 'kcode-content',
    disconnect: () => {},
    postMessage: (message: unknown) => { events.push(message as typeof events[number]); void router.fromContent(routerContent as chrome.runtime.Port, message); },
    onMessage: { addListener: (listener: typeof receiveContent) => { receiveContent = listener; } },
    onDisconnect: { addListener: () => {} },
  } as unknown as chrome.runtime.Port, adapterForOrigin(origin, document)!, {
    location: href as Location,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
  });
  controller.start();

  // Transactional in-memory VM. Never evaluates model-provided shell text.
  const files = new Map<string, string>();
  let staged = new Map<string, string>();
  let transactionId = 'no_transaction';
  const journal = () => ({ transactionId, state: 'dirty' as const,
    entries: [...staged].map(([path, content]) => ({ path, operation: 'write' as const, originalBytes: 0, resultingBytes: new TextEncoder().encode(content).length })),
    journalBytes: 0, writtenBytes: [...staged.values()].reduce((n, text) => n + new TextEncoder().encode(text).length, 0) });
  const result = (text: string) => ({ text, transactionId, journalSummary: journal() });
  const vm = {
    start: vi.fn(async () => { transactionId = 'no_transaction'; }),
    attachWorkspace: vi.fn(async () => {}),
    beginTransaction: vi.fn(async (id: string) => { transactionId = id; staged = new Map(); }),
    exec: vi.fn(async (command: string) => {
      if (command !== 'cd /work && ls -la /work') throw new Error('SIMULATED_COMMAND_UNSUPPORTED');
      return { output: [...files.keys()].join('\n') || '(empty workspace)', exitCode: 0, truncated: false, durationMs: 1, transactionId, journalSummary: journal() };
    }),
    writeFile: vi.fn(async (path: string, content: string) => { staged.set(path, content); return result(`Wrote ${path}`); }),
    readFile: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error('SIMULATED_FILE_NOT_FOUND');
      return result(files.get(path)!);
    }),
    commitTransaction: vi.fn(async () => { for (const [path, content] of staged) files.set(path, content); staged.clear(); }),
    rollbackTransaction: vi.fn(async () => { staged.clear(); }),
    terminate: vi.fn(),
  };
  const dispatcher = new ToolDispatcher(vm, async () => ({ workspaceId: 'simulation', handle: {} as FileSystemDirectoryHandle, network: { mode: 'offline' }, memoryProfile: 'standard' }));
  const states: string[] = [];
  const recoveries: string[] = [];
  const approvals = vi.fn(async (call: ToolCall) => approve ? authorizationForTool(call, 'interactive') : null);
  const agent = new AgentOrchestrator({ tab: client, dispatcher,
    approvals: { requestTool: approvals, requestResultRelease: async () => true },
    changes: { review: async () => 'accept' },
    consents: { hasValid: async () => false, revokeAll: async () => {} },
    onState: state => states.push(state), onRecovery: text => recoveries.push(text),
  });
  let outcome: AgentOutcome | undefined;
  let pending: Promise<AgentOutcome> | undefined;
  return {
    prompts, events, files, vm, approvals, states, recoveries, unexpectedPrompts, client,
    start: () => {
      pending = agent.run('创建 index.html 并读取验证', { tabId: 7, executionMode: 'confirm-each', consentContext: { workspaceId: 'simulation', relayUrl: null } });
      void pending.then(result => { outcome = result; });
      return pending;
    },
    finish: async (budgetMs = 30_000) => {
      for (let elapsed = 0; !outcome && elapsed < budgetMs; elapsed += 250) await vi.advanceTimersByTimeAsync(250);
      if (!outcome) throw new Error('SIMULATION_DID_NOT_SETTLE');
      return outcome;
    },
    cancel: () => agent.cancel('USER_STOP'),
    dispose: async () => {
      agent.cancel('SIMULATION_DISPOSED');
      if (pending) await pending;
      controller.dispose(); client.dispose();
      document.removeEventListener('click', onSend);
      document.removeEventListener('input', onInput);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
};
