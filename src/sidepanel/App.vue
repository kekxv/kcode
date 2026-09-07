<script lang="ts">
import type { InjectionKey } from 'vue';
import { normalizeRelayUrl, type ConsentContext } from '../security/risk-consent';
import type { WorkspaceStore } from '../utils/idb-store';
import type { ChatProvider, MemoryProfile } from '../types/protocol';
import type { TabClient } from './tab-client';
import type { VMClient } from './vm-client';
import type { RelaySettingsStore } from './relay-settings';
import type { AgentSettingsStore } from './agent-settings';
import type { RecoveryCheckpoint, WorkspaceHistoryStore } from './workspace-history';
import type { WorkRecord } from './work-history';
import type { ExecutionMode } from './execution-settings';
import type { ThemeMode } from './theme-settings';
export type SidePanelServices = {
  workspace: Pick<WorkspaceStore, 'load' | 'selectDirectory' | 'getPermission' | 'requestReadWrite'>;
  tab: Pick<TabClient, 'listConnectedTabs' | 'sendPrompt'>;
  vm: Pick<VMClient, 'terminate' | 'selectMemoryProfile' | 'attachWorkspace' | 'start' | 'exec' | 'readFile' | 'writeFile' | 'beginTransaction' | 'commitTransaction' | 'rollbackTransaction' | 'subscribe' | 'sendInput'>;
  consent: { grant(modes: readonly ('auto' | 'workspace-networked')[], context: ConsentContext): Promise<void>; hasValid(mode: 'auto' | 'workspace-networked', context: ConsentContext): Promise<boolean>; revokeAll(): Promise<void> };
  relaySettings: Pick<RelaySettingsStore, 'load' | 'save' | 'clear'>;
  agentSettings: Pick<AgentSettingsStore, 'load' | 'save' | 'clear'>;
  workspaceHistory: Pick<WorkspaceHistoryStore, 'load' | 'append' | 'clear' | 'loadRecovery' | 'saveRecovery' | 'clearRecovery'>;
  executionSettings?: { load(): Promise<ExecutionMode>; save(mode: ExecutionMode): Promise<ExecutionMode> };
  themeSettings?: { load(): Promise<ThemeMode>; save(mode: ThemeMode): Promise<ThemeMode> };
};
export const sidePanelServicesKey: InjectionKey<SidePanelServices> = Symbol('sidePanelServices');
</script>
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { StoredWorkspace } from '../utils/idb-store';
import { authorizationForTool, type ChangeDecision, type GuardedResult, type ToolAuthorization, type ToolCall, type ToolExecution } from '../types/tools';
import AutoModeStatus from './components/AutoModeStatus.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import ChatFeed from './components/ChatFeed.vue';
import { assistantProse, type ChatMessage } from './chat-message';
import ChangeReview from './components/ChangeReview.vue';
import RiskConsentDialog from './components/RiskConsentDialog.vue';
import ResultRelease from './components/ResultRelease.vue';
import TaskComposer from './components/TaskComposer.vue';
import TerminalPane from './components/TerminalPane.vue';
import type { ImageAttachment } from '../types/attachments';
import WorkspaceBar from './components/WorkspaceBar.vue';
import ShellConsole from './components/ShellConsole.vue';
import ToolApproval from './components/ToolApproval.vue';
import NetworkSettings from './components/NetworkSettings.vue';
import AgentSettings from './components/AgentSettings.vue';
import { continuationPrompt } from './history-prompt';
import { AgentOrchestrator } from './agent-orchestrator';
import { ToolDispatcher } from './tool-dispatcher';
import { DefaultResultGuard } from '../security/result-guard';
const services = inject(sidePanelServicesKey);
if (!services) throw new Error('SIDE_PANEL_SERVICES_UNAVAILABLE');
const workspace = ref<StoredWorkspace | null>(null);
const permission = ref<PermissionState | 'unavailable'>('unavailable');
const tabs = ref<Array<{ id: number; title: string; provider: ChatProvider }>>([]);
const selectedTabId = ref<number | null>(null);
const executionMode = ref<ExecutionMode>('confirm-each');
let modeRevision = 0;
const startingTask = ref(false);
const memoryProfile = ref<MemoryProfile>('standard');
const pendingMemoryProfile = ref<MemoryProfile | null>(null);
const showMemoryProfileWarning = ref(false);
const networkMode = ref<'offline' | 'wisp'>('offline');
const relayUrl = ref(''); const savedRelayUrl = ref<string | null>(null); const relayError = ref<string | null>(null); const activeRelayUrl = ref<string | null>(null); const autoRequested = ref(false); const networkRequested = ref(false); const showConsent = ref(false);
const customInstructions = ref(''); const customInstructionsError = ref<string | null>(null);
const messages = ref<ChatMessage[]>([]); const terminalChunks = ref<string[]>([]); const busy = ref(false);
const workHistory = ref<readonly WorkRecord[]>([]);
const selectedHistoryId = ref('');
const historyContext = ref<WorkRecord | null>(null);
const openHistory = (id: string): void => {
  if (busy.value || shellRunning.value) return;
  selectedHistoryId.value = id;
  const record = workHistory.value.find(item => item.id === id);
  historyContext.value = record ?? null;
  messages.value = record?.messages ? JSON.parse(JSON.stringify(record.messages)) : record ? [
    { role: 'system', text: '旧版记录仅保存了摘要，无法还原当时的工具日志。' },
    { role: 'user', text: record.task },
    { role: 'assistant', text: record.outcome },
  ] : [];
  agentState.value = 'idle';
  assistantMessageIndex = null; activeToolMessageIndex = null;
};
const historyEnabled = ref(false); const historyError = ref<string | null>(null);
const recovery = ref<RecoveryCheckpoint | null>(null); const recoveryError = ref<string | null>(null);
const historyGuard = new DefaultResultGuard();
const agentState = ref('idle');
const themeMode = ref<ThemeMode>('system');
const systemDark = ref(false);
const effectiveTheme = computed(() => themeMode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : themeMode.value);
const settingsOpen = ref(false);
const terminalOpen = ref(false);
const shellRunning = ref(false);
const shellChunks = ref<string[]>([]);
const shellStatus = ref('');
let shellController: AbortController | null = null;
const folderName = computed(() => workspace.value ? workspace.value.handle.name || '项目' : null);
const providerName = computed(() => tabs.value.find(tab => tab.id === selectedTabId.value)?.provider ?? null);
const refreshing = ref(false);
const connectionError = ref<string | null>(null);
const refreshNote = ref('');
let refreshInFlight = false;
let refreshAgain = false;

type ToolDecision = { call: ToolCall; finish: (authorization: ToolAuthorization | null) => void };
type ChangeReviewDecision = { execution: ToolExecution; finish: (decision: ChangeDecision | null) => void };
type ReleaseDecision = { result: GuardedResult; finish: (approved: boolean) => void };
const pendingTool = shallowRef<ToolDecision | null>(null);
const pendingChanges = shallowRef<ChangeReviewDecision | null>(null);
const pendingRelease = shallowRef<ReleaseDecision | null>(null);
let authorityGeneration = 0;
const pendingAuthorityGrants = new Set<Promise<unknown>>();
let orchestrator: AgentOrchestrator | null = null;
let activeTask: Promise<void> | null = null;
const directoryStatus = computed(() => permission.value === 'granted' ? '可读' : permission.value === 'prompt' ? '需要授权' : '未选择');
const webpageStatus = computed(() => tabs.value.length === 0 ? '未连接' : tabs.value.length === 1 ? '已连接' : '请选择页面');
const canSubmit = computed(() => permission.value === 'granted' && selectedTabId.value !== null && !busy.value && !shellRunning.value && !startingTask.value);
const taskSetupHint = computed(() => {
  if (agentState.value === 'failed') return '任务已结束（失败）。可修改任务后重新开始。';
  if (agentState.value === 'completed') return '任务已完成。可以继续提出新任务。';
  if (agentState.value === 'cancelled') return '任务已停止。';
  if (busy.value) return '任务正在运行；如需中断，请使用“一键停止”。';
  if (permission.value !== 'granted') return '请先选择并授权工作目录。';
  if (selectedTabId.value === null) return tabs.value.length > 1 ? '请在会话设置中选择一个聊天页面。' : '请先打开并连接一个支持的聊天页面。';
  return null;
});
const conversationElement = ref<HTMLElement | null>(null);
const followLatest = ref(true);
const scrollLatest = (): void => {
  followLatest.value = true;
  const element = conversationElement.value;
  if (element) element.scrollTop = element.scrollHeight;
};
const trackScroll = (): void => {
  const element = conversationElement.value;
  if (element) followLatest.value = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
};
watch(() => [messages.value.length, messages.value.at(-1)?.text, agentState.value], async () => {
  await nextTick();
  if (followLatest.value) scrollLatest();
});
const taskStatusLabel = computed(() => ({
  idle: '准备就绪', 'waiting-ai': '正在等待模型回复', 'awaiting-tool-approval': '需要你的确认',
  'running-tool': '正在执行工具', 'reviewing-changes': '等待审阅变更',
  'awaiting-result-release': '等待发送结果', completed: '任务已完成', failed: '执行失败', cancelled: '任务已停止',
}[agentState.value] ?? '正在处理'));
const completedTools = computed(() => {
  const lastUser = messages.value.map(message => message.role).lastIndexOf('user');
  return messages.value.slice(lastUser + 1).filter(message => message.role === 'tool' && message.status === 'done').length;
});
const vmStatus = computed(() => busy.value ? agentState.value : '未启动');
const currentCapability = computed(() => pendingTool.value ? authorizationForTool(pendingTool.value.call, 'interactive').capabilities[0] : '只读');
const journalStatus = computed(() => pendingChanges.value?.execution.journalSummary.state ?? '无未完成日志');
const releaseStatus = computed(() => pendingRelease.value ? '等待发送批准' : '本地保留');
const relayOrigin = computed(() => { try { return relayUrl.value ? new URL(relayUrl.value).origin : '离线'; } catch { return '无效中继'; } });
const refreshWorkspace = async (): Promise<void> => { workspace.value = await services.workspace.load(); permission.value = workspace.value ? await services.workspace.getPermission() : 'unavailable'; };
const refreshWorkHistory = async (): Promise<void> => {
  const selected = workspace.value;
  if (!selected) { workHistory.value = []; return; }
  const records = await services.workspaceHistory.load(selected.handle);
  if (workspace.value?.workspaceId === selected.workspaceId) {
    workHistory.value = records;
    historyError.value = null;
    if (!messages.value.length && !busy.value && records.length) openHistory(records[0]!.id);
  }
};
const refreshRecovery = async (): Promise<void> => { if (workspace.value) recovery.value = await services.workspaceHistory.loadRecovery(workspace.value.handle); };
const enableWorkHistory = async (): Promise<boolean> => {
  if (!workspace.value) return false;
  historyError.value = null;
  try {
    if (await services.workspace.requestReadWrite() !== 'granted') throw new Error('DIRECTORY_PERMISSION_DENIED');
    historyEnabled.value = true;
    await refreshWorkHistory();
    return true;
  } catch { historyError.value = '未获得写入工作目录 .session 的授权；任务仍可正常运行。'; return false; }
};
const clearWorkHistory = async (): Promise<void> => {
  if (!workspace.value || !historyEnabled.value) return;
  try { await services.workspaceHistory.clear(workspace.value.handle); workHistory.value = []; recovery.value = null; openHistory(''); } catch { historyError.value = '清除工作记录失败。'; }
};
const refreshTabs = async (): Promise<void> => {
  const connected = await services.tab.listConnectedTabs();
  tabs.value = connected;
  selectedTabId.value = connected.some((tab) => tab.id === selectedTabId.value)
    ? selectedTabId.value
    : connected.length === 1 ? connected[0].id : null;
};
const refreshChatConnection = async (manual: unknown = false): Promise<void> => {
  if (refreshInFlight) { if (manual === true) { refreshing.value = true; refreshAgain = true; } return; }
  refreshInFlight = true;
  if (manual === true) { refreshing.value = true; refreshNote.value = ''; }
  try { await refreshTabs(); connectionError.value = null; if (manual === true) refreshNote.value = tabs.value.length ? '已更新' : '未发现页面'; }
  catch { connectionError.value = '请刷新聊天网页后重试'; tabs.value = []; selectedTabId.value = null; if (manual === true) refreshNote.value = '请重试'; }
  finally { if (refreshing.value) refreshNote.value = connectionError.value ? '请重试' : tabs.value.length ? '已更新' : '未发现页面'; refreshing.value = false; refreshInFlight = false; if (refreshAgain) { refreshAgain = false; void refreshChatConnection(true); } }
};
const isCurrentAuthorityGeneration = (generation: number): boolean => generation === authorityGeneration;
const stopAndRevoke = async (reason = 'USER_STOP'): Promise<number> => {
  const generation = ++authorityGeneration;
  shellController?.abort(reason);
  orchestrator?.cancel(reason);
  busy.value = false;
  services.vm.terminate(reason);
  executionMode.value = 'confirm-each';
  networkMode.value = 'offline';
  activeRelayUrl.value = null;
  autoRequested.value = false;
  networkRequested.value = false;
  showConsent.value = false;
  await Promise.allSettled([...pendingAuthorityGrants]);
  if (isCurrentAuthorityGeneration(generation)) await services.consent.revokeAll();
  return generation;
};
const chooseDirectory = async (): Promise<void> => {
  const reset = stopAndRevoke();
  const selection = services.workspace.selectDirectory().then(value => ({ value }), error => ({ error }));
  await reset;
  const picked = await selection;
  if ('error' in picked) return;
  workspace.value = picked.value;
  permission.value = await services.workspace.getPermission();
  historyEnabled.value = false;
  recovery.value = null;
  workHistory.value = []; openHistory('');
  void refreshWorkHistory().catch(() => { historyError.value = '读取工作记录失败，请确认目录读取权限。'; });
  void refreshRecovery().catch(() => { recoveryError.value = '读取可恢复任务失败。'; });
};
const applyMemoryProfile = async (profile: MemoryProfile): Promise<void> => {
  if (profile === memoryProfile.value) return;
  // A RAM geometry is part of every authority boundary. Reset the same
  // session-scoped auto/relay consent context before retaining the next
  // cold-boot preference.
  const generation = await stopAndRevoke('VM_MEMORY_PROFILE_CHANGED');
  if (!isCurrentAuthorityGeneration(generation)) return;
  services.vm.selectMemoryProfile(profile);
  memoryProfile.value = profile;
  pendingMemoryProfile.value = null;
  showMemoryProfileWarning.value = false;
};
const requestMemoryProfile = (event: Event): void => {
  const next = (event.target as HTMLSelectElement).value;
  if (next === 'high') {
    pendingMemoryProfile.value = 'high';
    showMemoryProfileWarning.value = true;
    (event.target as HTMLSelectElement).value = memoryProfile.value;
    return;
  }
  void applyMemoryProfile('standard');
};
const confirmHighMemoryProfile = (): void => { if (pendingMemoryProfile.value === 'high') void applyMemoryProfile('high'); };
const cancelMemoryProfileChange = (): void => { pendingMemoryProfile.value = null; showMemoryProfileWarning.value = false; };
const rememberExecutionMode = async (): Promise<void> => {
  try { await services.executionSettings?.save(executionMode.value); }
  catch { messages.value.push({ role: 'system', text: '编辑模式已切换，但保存偏好失败。' }); }
};
const changeExecutionMode = async (event: Event): Promise<void> => {
  const requested = (event.target as HTMLSelectElement).value as 'confirm-each' | 'auto-write' | 'auto';
  if (!['confirm-each', 'auto-write', 'auto'].includes(requested) || busy.value || shellRunning.value) return;
  modeRevision += 1;
  if (requested === 'confirm-each') { executionMode.value = requested; autoRequested.value = false; await rememberExecutionMode(); return; }
  const selected = workspace.value;
  if (!selected) return;
  const generation = authorityGeneration;
  try {
    // The explicit mode selection is the user gesture authorizing this session.
    const permission = services.workspace.requestReadWrite();
    const grant = services.consent.grant(['auto'], { workspaceId: selected.workspaceId, relayUrl: networkMode.value === 'wisp' ? activeRelayUrl.value : null });
    const pending = Promise.all([permission, grant]);
    pendingAuthorityGrants.add(pending);
    try {
      const [allowed] = await pending;
      if (!isCurrentAuthorityGeneration(generation) || allowed !== 'granted') return;
      executionMode.value = requested;
      autoRequested.value = true;
      await rememberExecutionMode();
    } finally { pendingAuthorityGrants.delete(pending); }
  } catch { messages.value.push({ role: 'system', text: '切换失败：请确认工作目录的读写授权后重试。' }); }
  finally { (event.target as HTMLSelectElement).value = executionMode.value; }
};
const requestHighRiskMode = (event: Event, mode: 'auto' | 'workspace-networked'): void => {
  const input = event.target as HTMLInputElement;
  const checked = input.checked;
  input.checked = false;
  if (mode === 'workspace-networked' && checked && savedRelayUrl.value === null) {
    relayError.value = '请先保存有效的 WISP relay URL';
    return;
  }
  const requestedAuto = mode === 'auto' ? checked : autoRequested.value;
  const requestedNetwork = mode === 'workspace-networked' ? checked : networkRequested.value;
  void stopAndRevoke().then((generation) => {
    if (!isCurrentAuthorityGeneration(generation)) return;
    autoRequested.value = requestedAuto;
    networkRequested.value = requestedNetwork;
    showConsent.value = requestedAuto || requestedNetwork;
  });
};
const rejectConsent = (): void => { void stopAndRevoke(); };
const changeRelayUrl = (next: string): void => {
  relayUrl.value = next;
  if (networkMode.value !== 'wisp') return;
  try {
    if (normalizeRelayUrl(next) !== activeRelayUrl.value) void stopAndRevoke('RELAY_URL_CHANGED');
  } catch {
    void stopAndRevoke('RELAY_URL_CHANGED');
  }
};
const saveRelayUrl = async (): Promise<void> => {
  relayError.value = null;
  let normalized: string;
  try { normalized = normalizeRelayUrl(relayUrl.value); } catch { relayError.value = 'WISP relay URL 无效'; return; }
  if (normalized !== savedRelayUrl.value) {
    const generation = await stopAndRevoke('RELAY_URL_CHANGED');
    if (!isCurrentAuthorityGeneration(generation)) return;
  }
  try {
    const saved = await services.relaySettings.save(normalized);
    relayUrl.value = saved;
    savedRelayUrl.value = saved;
  } catch { relayError.value = 'WISP relay URL 保存失败'; }
};
const clearRelayUrl = async (): Promise<void> => {
  relayError.value = null;
  const generation = await stopAndRevoke('RELAY_URL_CHANGED');
  if (!isCurrentAuthorityGeneration(generation)) return;
  try {
    await services.relaySettings.clear();
    relayUrl.value = '';
    savedRelayUrl.value = null;
  } catch { relayError.value = 'WISP relay URL 清除失败'; }
};
const saveCustomInstructions = async (): Promise<void> => {
  customInstructionsError.value = null;
  try { customInstructions.value = await services.agentSettings.save(customInstructions.value); } catch { customInstructionsError.value = '自定义 Agent 指令保存失败或超过 16 KiB'; }
};
const clearCustomInstructions = async (): Promise<void> => {
  customInstructionsError.value = null;
  try { await services.agentSettings.clear(); customInstructions.value = ''; } catch { customInstructionsError.value = '自定义 Agent 指令清除失败'; }
};
const acceptConsent = async (): Promise<void> => {
  const selected = workspace.value; if (!selected) return rejectConsent();
  const generation = authorityGeneration;
  const modes = [...(autoRequested.value ? ['auto' as const] : []), ...(networkRequested.value ? ['workspace-networked' as const] : [])];
  let normalizedRelayUrl: string | null = null;
  try {
    normalizedRelayUrl = networkRequested.value && savedRelayUrl.value ? normalizeRelayUrl(savedRelayUrl.value) : null;
    if (networkRequested.value && normalizedRelayUrl === null) throw new Error('CONSENT_RELAY_REQUIRED');
  } catch {
    await stopAndRevoke('RELAY_URL_CHANGED');
    return;
  }
  const context = { workspaceId: selected.workspaceId, relayUrl: normalizedRelayUrl };
  const writePermission = autoRequested.value ? services.workspace.requestReadWrite() : Promise.resolve<'granted'>('granted');
  const grant = services.consent.grant(modes, context);
  const authorityGrant = Promise.all([writePermission, grant]);
  pendingAuthorityGrants.add(authorityGrant);
  try {
    const [result] = await authorityGrant;
    if (!isCurrentAuthorityGeneration(generation)) return;
    if (result !== 'granted') throw new Error('DIRECTORY_PERMISSION_DENIED');
    activeRelayUrl.value = normalizedRelayUrl;
    executionMode.value = autoRequested.value ? 'auto' : 'confirm-each';
    await rememberExecutionMode();
    networkMode.value = networkRequested.value ? 'wisp' : 'offline';
    showConsent.value = false;
  } catch {
    if (isCurrentAuthorityGeneration(generation)) await stopAndRevoke();
  } finally {
    pendingAuthorityGrants.delete(authorityGrant);
  }
};
const waitForToolApproval = (call: ToolCall, signal: AbortSignal): Promise<ToolAuthorization | null> => new Promise((resolve) => {
  const finish = (authorization: ToolAuthorization | null): void => { signal.removeEventListener('abort', abort); if (pendingTool.value?.call === call) pendingTool.value = null; resolve(authorization); };
  const abort = (): void => finish(null);
  if (signal.aborted) return abort();
  pendingTool.value = { call, finish };
  signal.addEventListener('abort', abort, { once: true });
});
const waitForChangeReview = (execution: ToolExecution, signal: AbortSignal): Promise<ChangeDecision | null> => new Promise((resolve) => {
  const finish = (decision: ChangeDecision | null): void => { signal.removeEventListener('abort', abort); if (pendingChanges.value?.execution === execution) pendingChanges.value = null; resolve(decision); };
  const abort = (): void => finish(null);
  if (signal.aborted) return abort();
  pendingChanges.value = { execution, finish };
  signal.addEventListener('abort', abort, { once: true });
});
const waitForResultRelease = (result: GuardedResult, signal: AbortSignal): Promise<boolean> => new Promise((resolve) => {
  const finish = (approved: boolean): void => { signal.removeEventListener('abort', abort); if (pendingRelease.value?.result === result) pendingRelease.value = null; resolve(approved); };
  const abort = (): void => finish(false);
  if (signal.aborted) return abort();
  pendingRelease.value = { result, finish };
  signal.addEventListener('abort', abort, { once: true });
});
const dispatcher = new ToolDispatcher(services.vm, async () => {
  const selected = workspace.value;
  if (!selected || permission.value !== 'granted') throw new Error('WORKSPACE_NOT_READY');
  return {
    workspaceId: selected.workspaceId,
    handle: selected.handle,
    network: networkMode.value === 'wisp' && activeRelayUrl.value ? { mode: 'wisp', relayUrl: activeRelayUrl.value } : { mode: 'offline' },
    memoryProfile: memoryProfile.value,
  };
}, (context) => services.consent.hasValid('workspace-networked', context), true);
const runShell = async (command: string, size?: { cols: number; rows: number }): Promise<void> => {
  if (busy.value || shellRunning.value || !workspace.value) return;
  const controller = new AbortController();
  shellController = controller; shellRunning.value = true; shellStatus.value = '准备 VM…';
  let streamed = false;
  let retainedBytes = 0;
  const append = (text: string) => {
    const kept = text.slice(0, Math.max(0, 1_048_576 - retainedBytes));
    retainedBytes += kept.length;
    if (kept) shellChunks.value.push(kept);
  };
  if (shellChunks.value.join('').length > 1_048_576) shellChunks.value = shellChunks.value.slice(-100);
  append('\r\n$ ' + command + '\r\n');
  const unsubscribe = services.vm.subscribe(event => { if (event.kind === 'delta' && !controller.signal.aborted) { streamed = true; append(event.delta); } });
  try {
    const allowed = await services.workspace.requestReadWrite();
    if (controller.signal.aborted) { shellStatus.value = '已停止'; return; }
    if (new TextEncoder().encode(command).byteLength > 32768) throw new Error('命令不能超过 32 KiB');
    if (allowed !== 'granted') throw new Error('DIRECTORY_PERMISSION_DENIED');
    permission.value = 'granted';
    shellStatus.value = '正在执行…';
    const result = await dispatcher.executeManualShell(command, controller.signal, size);
    if (controller.signal.aborted) return;
    await dispatcher.resolveChanges(result.transactionId, 'accept', controller.signal);
    if (!streamed) append(result.result.text);
    shellStatus.value = '命令结束 · exit ' + result.result.exitCode;
    append('\r\n[exit ' + result.result.exitCode + ']\r\n');
  } catch (error) {
    shellStatus.value = controller.signal.aborted ? '已停止，VM 将在下一次命令时重启' : '执行失败：' + (error instanceof Error ? error.message : 'VM_ERROR');
    append('\r\n' + shellStatus.value + '\r\n');
  } finally { unsubscribe(); shellRunning.value = false; if (shellController === controller) shellController = null; }
};
let shellInputQueue: Promise<void> = Promise.resolve();
const sendShellInput = (data: string): void => {
  if (!shellRunning.value || busy.value) return;
  const controller = shellController;
  const chars = Array.from(data);
  // Serialize paste and keystrokes; queued input never crosses command boundaries.
  shellInputQueue = shellInputQueue.then(async () => {
    for (let offset = 0; offset < chars.length; offset += 1024) {
      while (shellController === controller && controller && !controller.signal.aborted) {
        try { await services.vm.sendInput(chars.slice(offset, offset + 1024).join('')); break; }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'VM_STDIN_NOT_READY') throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      if (shellController !== controller || !controller || controller.signal.aborted) return;
    }
  }).catch(() => { if (shellController === controller) shellStatus.value = '输入未送达：命令可能已经结束'; });
};
const stopShell = (): void => { shellStatus.value = '正在停止…'; shellController?.abort('USER_STOP'); };
let assistantMessageIndex: number | null = null;
let activeToolMessageIndex: number | null = null;
orchestrator = new AgentOrchestrator({
  tab: services.tab,
  dispatcher,
  approvals: {
    requestTool: waitForToolApproval,
    requestResultRelease: waitForResultRelease,
  },
  changes: { review: async (summary, signal) => {
    const active = { transactionId: summary.transactionId, result: { text: '', exitCode: null, truncated: false, durationMs: 0 }, journalSummary: summary };
    return waitForChangeReview(active, signal);
  } },
  consents: services.consent,
  onState: (state) => {
    agentState.value = state;
    if (activeToolMessageIndex !== null) {
      const status: ChatMessage['status'] = state === 'awaiting-tool-approval' ? 'approval'
        : state === 'running-tool' ? 'running' : state === 'reviewing-changes' ? 'review'
          : state === 'awaiting-result-release' ? 'release' : state === 'failed' ? 'failed'
            : state === 'cancelled' ? 'cancelled' : state === 'waiting-ai' || state === 'completed' ? 'done' : undefined;
      if (status) messages.value[activeToolMessageIndex]!.status = status;
      if (status === 'done' || status === 'failed' || status === 'cancelled') activeToolMessageIndex = null;
    }
    if (state === 'waiting-ai') assistantMessageIndex = null;
  },
  onToolResult: (result) => {
    if (activeToolMessageIndex !== null) messages.value[activeToolMessageIndex]!.result = { ...result };
  },
  onRecovery: (message) => messages.value.push({ role: 'system', text: message }),
  onTool: (call) => {
    const entry: ChatMessage = { role: 'tool', text: '', tool: call, status: 'approval' };
    if (assistantMessageIndex === null) {
      assistantMessageIndex = messages.value.length;
      messages.value.push(entry);
    } else {
      const prose = assistantProse(messages.value[assistantMessageIndex]!.text);
      if (prose.trim()) {
        messages.value[assistantMessageIndex]!.text = prose;
        assistantMessageIndex = messages.value.length;
        messages.value.push(entry);
      } else messages.value[assistantMessageIndex] = entry;
    }
    activeToolMessageIndex = assistantMessageIndex;
  },
  onDelta: (delta) => {
    if (assistantMessageIndex === null) {
      assistantMessageIndex = messages.value.length;
      messages.value.push({ role: 'assistant', text: delta });
    } else messages.value[assistantMessageIndex]!.text += delta;
  },
});
const approveTool = (): void => { const pending = pendingTool.value; if (pending) pending.finish(authorizationForTool(pending.call, 'interactive')); };
const rejectTool = (): void => pendingTool.value?.finish(null);
const decideChanges = (decision: ChangeDecision): void => pendingChanges.value?.finish(decision);
const decideRelease = (approved: boolean): void => pendingRelease.value?.finish(approved);
const stopTask = async (): Promise<void> => {
  const wasRunning = busy.value;
  // Abort the orchestrator first. Its finally path waits for ToolDispatcher to
  // roll back an active transaction before this UI tears down the VM.
  orchestrator?.cancel('USER_STOP');
  const running = activeTask;
  if (running) await running;
  await stopAndRevoke('USER_STOP');
  if (!wasRunning) messages.value.push({ role: 'system', text: '当前没有正在执行的任务。' });
};
const resumeRecovery = async (): Promise<void> => {
  const checkpoint = recovery.value;
  if (!checkpoint) return;
  recoveryError.value = null;
  if (!await enableWorkHistory()) { recoveryError.value = '恢复任务需要重新确认对 .session 的写入授权。'; return; }
  const tab = tabs.value.find((candidate) => candidate.id === selectedTabId.value);
  if (!tab || tab.provider !== checkpoint.provider) { recoveryError.value = `请选择 ${checkpoint.provider} 页面后再恢复。`; return; }
  await submit(`继续此前被重启中断的任务。\n原任务：${checkpoint.task}\n已保存进度：${checkpoint.summary}\n请检查当前工作区后继续，不要假定未确认的工具调用已经执行。`);
};
// Redact each string without applying the model-release output limit. Keep image bytes intact.
const snapshotHistory = (): ChatMessage[] => JSON.parse(JSON.stringify(messages.value, (key, value) =>
  typeof value === 'string' && key !== 'dataUrl'
    ? historyGuard.redact({ text: value, exitCode: null, truncated: false, durationMs: 0 }, Infinity).redactedText : value));
const runTask = async (prompt: string, images?: ImageAttachment[]): Promise<void> => {
  if (!canSubmit.value || selectedTabId.value === null || !workspace.value || !orchestrator) return;
  if (executionMode.value !== 'confirm-each' && !autoRequested.value) {
    startingTask.value = true;
    try { await changeExecutionMode({ target: { value: executionMode.value } } as unknown as Event); }
    finally { startingTask.value = false; }
    if (!autoRequested.value || !canSubmit.value) return;
  }
  busy.value = true;
  agentState.value = 'waiting-ai';
  try {
    messages.value.push({ role: 'user', text: prompt, images });
    const selected = tabs.value.find((tab) => tab.id === selectedTabId.value);
    const guardedTask = historyGuard.redact({ text: prompt, exitCode: null, truncated: false, durationMs: 0 }, Infinity).redactedText;
    if (historyEnabled.value && selected) {
      try {
        const checkpoint: RecoveryCheckpoint = { updatedAt: Date.now(), provider: selected.provider, task: guardedTask, phase: 'running', summary: '任务已启动；重启后请确认恢复。' };
        await services.workspaceHistory.saveRecovery(workspace.value.handle, checkpoint);
        recovery.value = checkpoint;
      } catch { historyError.value = '保存恢复状态失败；任务仍可正常运行。'; }
    }
    const previous = historyContext.value;
    const request = previous ? continuationPrompt(previous, prompt) : prompt;
    historyContext.value = null;
    const outcome = await orchestrator.run(request, {
      tabId: selectedTabId.value,
      executionMode: executionMode.value,
      memoryProfile: memoryProfile.value,
      consentContext: { workspaceId: workspace.value.workspaceId, relayUrl: networkMode.value === 'wisp' ? activeRelayUrl.value : null },
      customInstructions: customInstructions.value,
      images,
    });
    if (outcome.text && assistantMessageIndex === null) messages.value.push({ role: 'assistant', text: outcome.text });
    else if (outcome.code) {
      const formatError = outcome.code === 'TOOL_FORMAT_RETRIES_EXHAUSTED';
      messages.value.push({ role: 'system', text: formatError
        ? `任务已结束（失败）：模型连续返回无效工具调用，自动修正两次后仍未成功；本轮工具未执行。可重新发起任务继续。错误：${outcome.code}`
        : outcome.code === 'TOOL_BRIDGE_UNAVAILABLE' ? '任务未完成：说明文本工具执行方式后，模型仍未能使用该协议。请更换模型或会话后重试。' : outcome.code.startsWith('IMAGE_') ? '图片未能确认上传，本次未发送任务。请检查聊天网页的附件状态后重试。错误：' + outcome.code : `任务结束：${outcome.code}${outcome.detail ? '\n' + outcome.detail : ''}` });
    }
    if (outcome.state === 'completed') messages.value.push({ role: 'system', text: '任务已完成。' });
    try {
      if (historyEnabled.value && selected) {
        const result = historyGuard.redact({ text: outcome.text || outcome.code || '', exitCode: null, truncated: false, durationMs: 0 }, Infinity).redactedText;
        await services.workspaceHistory.append(workspace.value.handle, { id: crypto.randomUUID(), createdAt: Date.now(), provider: selected.provider, task: guardedTask, outcome: result, status: outcome.state, messages: snapshotHistory() });
        await services.workspaceHistory.saveRecovery(workspace.value.handle, { updatedAt: Date.now(), provider: selected.provider, task: guardedTask, phase: outcome.state, summary: result });
        recovery.value = null;
        await refreshWorkHistory();
      }
    } catch { historyError.value = '保存完整工作记录失败，请检查目录权限或可用空间。'; }
  } catch {
    agentState.value = 'failed';
    messages.value.push({ role: 'system', text: '任务已结束（失败）：处理任务结果时发生错误，请重新开始。' });
  } finally {
    busy.value = false;
  }
};
const submit = (prompt: string, images?: ImageAttachment[]): Promise<void> => {
  const task = runTask(prompt, images);
  activeTask = task;
  return task.finally(() => { if (activeTask === task) activeTask = null; });
};
let chatRefreshTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  const initialGeneration = authorityGeneration;
  const initialModeRevision = modeRevision;
  void services.executionSettings?.load().then(mode => {
    if (authorityGeneration === initialGeneration && modeRevision === initialModeRevision && !busy.value && executionMode.value === 'confirm-each' && !autoRequested.value) executionMode.value = mode;
  }).catch(() => {});
  void refreshWorkspace().then(async () => {
    await Promise.all([
      refreshWorkHistory().catch(() => { historyError.value = '读取工作记录失败，请重新选择并授权项目目录。'; }),
      refreshRecovery().catch(() => { recoveryError.value = '读取可恢复任务失败。'; }),
    ]);
  }).catch(() => { historyError.value = '加载项目失败，请重新选择项目目录。'; });
  refreshChatConnection();
  chatRefreshTimer = setInterval(refreshChatConnection, 2_000);
  window.addEventListener('focus', refreshChatConnection);
  void services.relaySettings.load().then((saved) => { if (saved) { savedRelayUrl.value = saved; relayUrl.value = saved; } }).catch(() => { relayError.value = 'WISP relay URL 读取失败'; });
  void services.agentSettings.load().then((saved) => { customInstructions.value = saved; }).catch(() => { customInstructionsError.value = '自定义 Agent 指令读取失败'; });
  void services.themeSettings?.load().then((saved) => { themeMode.value = saved; }).catch(() => {});
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (media) { systemDark.value = media.matches; media.addEventListener?.('change', (event) => { systemDark.value = event.matches; }); }
});
onBeforeUnmount(() => {
  shellController?.abort('PANEL_CLOSED');
  if (chatRefreshTimer) clearInterval(chatRefreshTimer);
  window.removeEventListener('focus', refreshChatConnection);
});
const setTheme = async (mode: ThemeMode): Promise<void> => { themeMode.value = await services.themeSettings?.save(mode) ?? mode; };
</script>
<template>
  <main class="side-panel" :data-theme="effectiveTheme">
    <WorkspaceBar :folder="folderName" :permission="permission" :provider="providerName" :refreshing="refreshing" :connection-error="connectionError" :refresh-note="refreshNote" :mode="executionMode" :locked="busy || shellRunning" @choose="chooseDirectory" @settings="settingsOpen = true" @refresh="refreshChatConnection(true)" @mode="changeExecutionMode({ target: { value: $event } } as unknown as Event)">
    <HistoryPanel :records="workHistory" :selected-id="selectedHistoryId" :locked="busy || shellRunning" @select="openHistory" />
    <div class="terminal-toggle-row"><button aria-label="切换终端" title="终端" :aria-expanded="terminalOpen" @click="terminalOpen = !terminalOpen">⌘</button><small>{{ shellRunning ? 'VM 执行中' : busy ? 'Agent 工作中' : '' }}</small></div>
    </WorkspaceBar>
    <p v-if="historyError && !settingsOpen" class="history-error" role="alert">{{ historyError }}</p>
    <section v-if="settingsOpen" class="settings-backdrop" role="presentation" @click.self="settingsOpen = false"><section class="settings-dialog" role="dialog" aria-modal="true" aria-label="会话设置"><header><strong>会话设置</strong><button aria-label="关闭设置" @click="settingsOpen = false">×</button></header><div class="settings-scroll"><p class="settings-intro">外观、执行权限与项目偏好</p><label>主题<select :value="themeMode" @change="setTheme(($event.target as HTMLSelectElement).value as ThemeMode)"><option value="system">跟随浏览器</option><option value="light">亮色</option><option value="dark">暗色</option></select></label><div class="workspace-controls"><label>VM 内存<select :value="memoryProfile" @change="requestMemoryProfile"><option value="standard">标准（256 MiB）</option><option value="high">高内存（512 MiB）</option></select></label><label class="checkbox-label"><input :checked="autoRequested" type="checkbox" @change="requestHighRiskMode($event, 'auto')">启用 Auto</label><label class="checkbox-label"><input :checked="networkRequested" type="checkbox" @change="requestHighRiskMode($event, 'workspace-networked')">连接工作区网络</label><label v-if="tabs.length > 1">聊天页面<select v-model="selectedTabId"><option :value="null">请选择</option><option v-for="tab in tabs" :key="tab.id" :value="tab.id">{{ tab.provider }}：{{ tab.title }}</option></select></label></div><NetworkSettings v-model="relayUrl" :saved-url="savedRelayUrl" :error="relayError" @update:model-value="changeRelayUrl" @save="saveRelayUrl" @clear="clearRelayUrl" /><AgentSettings v-model="customInstructions" :error="customInstructionsError" @save="saveCustomInstructions" @clear="clearCustomInstructions" /><section class="history-settings" aria-label="工作记录"><button v-if="!historyEnabled" type="button" @click="enableWorkHistory">启用工作记录（写入 .session）</button><button v-else type="button" @click="clearWorkHistory">清除工作记录</button><p v-if="historyError" role="alert">{{ historyError }}</p><p v-if="workHistory.length === 0">暂无工作记录</p><p v-else>已保存 {{ workHistory.length }} 条任务记录，可从顶部“历史任务”查看。</p></section></div></section></section>
    <section ref="conversationElement" class="panel-content" @scroll="trackScroll">
    <section v-if="recovery?.phase === 'running'" aria-label="恢复上次任务"><p>上次任务在 {{ recovery.updatedAt }} 保存：{{ recovery.task }}</p><p>进度：{{ recovery.summary }}</p><p v-if="recoveryError">{{ recoveryError }}</p><button type="button" @click="resumeRecovery">恢复任务</button></section>
    <section v-if="showMemoryProfileWarning" role="dialog" aria-label="高内存冷启动确认"><p>切换到 512 MiB 会冷重启虚拟机，丢失活动命令、工作区挂载、事务和网络状态，并增加浏览器内存占用。</p><button @click="confirmHighMemoryProfile">确认切换到 512 MiB</button><button @click="cancelMemoryProfileChange">取消</button></section>
    <AutoModeStatus :workspace-name="workspace?.workspaceId ?? '未选择目录'" :relay-origin="relayOrigin" :auto="executionMode === 'auto'" :network="networkMode === 'wisp'" @stop="stopTask" />
    <RiskConsentDialog v-if="showConsent" :auto="autoRequested" :network="networkRequested" @accept="acceptConsent" @cancel="rejectConsent" />
    <section v-if="messages.length === 0" class="welcome"><span class="welcome-symbol" aria-hidden="true">✳</span><small>从一个想法开始</small><h1>今天，一起做点什么？</h1><p>浏览项目、修改文件、运行命令。<br>每一步进展，都在这里看得见。</p><div><button :disabled="!canSubmit" @click="submit('了解 /work 中的项目结构')">了解项目结构</button><button :disabled="!canSubmit" @click="submit('实现一个功能并验证')">实现一个功能</button></div></section><ChatFeed :messages="messages" />
    <ToolApproval v-if="pendingTool" :call="pendingTool.call" :workspace-name="workspace?.workspaceId ?? '未选择目录'" :network="networkMode === 'wisp' ? relayOrigin : 'offline'" @approve-tool="approveTool" @reject="rejectTool" />
    <ChangeReview v-if="pendingChanges" :summary="pendingChanges.execution.journalSummary" @accept="decideChanges('accept')" @rollback="decideChanges('rollback')" />
    <ResultRelease v-if="pendingRelease" :result="pendingRelease.result" @release="decideRelease(true)" @cancel="decideRelease(false)" />
<details v-if="terminalChunks.length" class="terminal-details"><summary>查看运行日志</summary><TerminalPane :chunks="terminalChunks" :theme="effectiveTheme" /></details></section>
    <button v-if="!followLatest" class="jump-latest" @click="scrollLatest">↓ 回到最新消息</button>
    <section v-if="(messages.length || busy)" class="task-status-bar" role="status" :data-state="agentState"><span class="activity-dot" :class="{ active: busy }"></span><strong>{{ taskStatusLabel }}</strong><small v-if="completedTools">{{ completedTools }} 步已完成</small></section>
    <p class="mode-hint">{{ executionMode === 'confirm-each' ? '手动：工具、变更和结果发送逐步确认' : executionMode === 'auto-write' ? '自动写入：读写文件自动执行；Shell 仍需确认；自动发送脱敏结果' : '全自动：工具自动执行、提交变更并发送脱敏结果' }}</p>
    <TaskComposer :disabled="!canSubmit" :hint="taskSetupHint" :busy="busy" :has-messages="messages.length > 0" @submit="submit" @cancel="stopTask" />
    <ShellConsole v-show="terminalOpen" :chunks="shellChunks" :theme="effectiveTheme" :running="shellRunning" :blocked="busy" :folder="folderName" :status="shellStatus" @close="terminalOpen = false" @stdin="sendShellInput" @toggle-theme="setTheme(effectiveTheme === 'light' ? 'dark' : 'light')" @execute="runShell" @stop="stopShell" @clear="shellChunks = []" />
  </main>
</template>
