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
import type { ThemeMode } from './theme-settings';
export type SidePanelServices = {
  workspace: Pick<WorkspaceStore, 'load' | 'selectDirectory' | 'getPermission' | 'requestReadWrite'>;
  tab: Pick<TabClient, 'listConnectedTabs' | 'sendPrompt'>;
  vm: Pick<VMClient, 'terminate' | 'selectMemoryProfile' | 'attachWorkspace' | 'start' | 'exec' | 'readFile' | 'writeFile' | 'beginTransaction' | 'commitTransaction' | 'rollbackTransaction' | 'subscribe'>;
  consent: { grant(modes: readonly ('auto' | 'workspace-networked')[], context: ConsentContext): Promise<void>; hasValid(mode: 'auto' | 'workspace-networked', context: ConsentContext): Promise<boolean>; revokeAll(): Promise<void> };
  relaySettings: Pick<RelaySettingsStore, 'load' | 'save' | 'clear'>;
  agentSettings: Pick<AgentSettingsStore, 'load' | 'save' | 'clear'>;
  workspaceHistory: Pick<WorkspaceHistoryStore, 'load' | 'append' | 'clear' | 'loadRecovery' | 'saveRecovery' | 'clearRecovery'>;
  themeSettings?: { load(): Promise<ThemeMode>; save(mode: ThemeMode): Promise<ThemeMode> };
};
export const sidePanelServicesKey: InjectionKey<SidePanelServices> = Symbol('sidePanelServices');
</script>
<script setup lang="ts">
import { computed, inject, onMounted, ref, shallowRef } from 'vue';
import type { StoredWorkspace } from '../utils/idb-store';
import { authorizationForTool, type ChangeDecision, type GuardedResult, type ToolAuthorization, type ToolCall, type ToolExecution } from '../types/tools';
import AutoModeStatus from './components/AutoModeStatus.vue';
import ChatFeed from './components/ChatFeed.vue';
import ChangeReview from './components/ChangeReview.vue';
import RiskConsentDialog from './components/RiskConsentDialog.vue';
import ResultRelease from './components/ResultRelease.vue';
import TaskComposer from './components/TaskComposer.vue';
import TerminalPane from './components/TerminalPane.vue';
import ToolApproval from './components/ToolApproval.vue';
import NetworkSettings from './components/NetworkSettings.vue';
import AgentSettings from './components/AgentSettings.vue';
import { AgentOrchestrator } from './agent-orchestrator';
import { ToolDispatcher } from './tool-dispatcher';
import { DefaultResultGuard } from '../security/result-guard';
const services = inject(sidePanelServicesKey);
if (!services) throw new Error('SIDE_PANEL_SERVICES_UNAVAILABLE');
const workspace = ref<StoredWorkspace | null>(null);
const permission = ref<PermissionState | 'unavailable'>('unavailable');
const tabs = ref<Array<{ id: number; title: string; provider: ChatProvider }>>([]);
const selectedTabId = ref<number | null>(null);
const executionMode = ref<'confirm-each' | 'auto'>('confirm-each');
const memoryProfile = ref<MemoryProfile>('standard');
const pendingMemoryProfile = ref<MemoryProfile | null>(null);
const showMemoryProfileWarning = ref(false);
const networkMode = ref<'offline' | 'wisp'>('offline');
const relayUrl = ref(''); const savedRelayUrl = ref<string | null>(null); const relayError = ref<string | null>(null); const activeRelayUrl = ref<string | null>(null); const autoRequested = ref(false); const networkRequested = ref(false); const showConsent = ref(false);
const customInstructions = ref(''); const customInstructionsError = ref<string | null>(null);
const messages = ref<string[]>([]); const terminalChunks = ref<string[]>([]); const busy = ref(false);
const workHistory = ref<readonly WorkRecord[]>([]);
const historyEnabled = ref(false); const historyError = ref<string | null>(null);
const recovery = ref<RecoveryCheckpoint | null>(null); const recoveryError = ref<string | null>(null);
const historyGuard = new DefaultResultGuard();
const agentState = ref('idle');
const themeMode = ref<ThemeMode>('system');
const systemDark = ref(false);
const effectiveTheme = computed(() => themeMode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : themeMode.value);
const settingsOpen = ref(false);
type ToolDecision = { call: ToolCall; finish: (authorization: ToolAuthorization | null) => void };
type ChangeReviewDecision = { execution: ToolExecution; finish: (decision: ChangeDecision | null) => void };
type ReleaseDecision = { result: GuardedResult; finish: (approved: boolean) => void };
const pendingTool = shallowRef<ToolDecision | null>(null);
const pendingChanges = shallowRef<ChangeReviewDecision | null>(null);
const pendingRelease = shallowRef<ReleaseDecision | null>(null);
let authorityGeneration = 0;
const pendingAuthorityGrants = new Set<Promise<unknown>>();
let orchestrator: AgentOrchestrator | null = null;
const directoryStatus = computed(() => permission.value === 'granted' ? '可读' : permission.value === 'prompt' ? '需要授权' : '未选择');
const webpageStatus = computed(() => tabs.value.length === 0 ? '未连接' : tabs.value.length === 1 ? '已连接' : '请选择页面');
const canSubmit = computed(() => permission.value === 'granted' && selectedTabId.value !== null && !busy.value);
const vmStatus = computed(() => busy.value ? agentState.value : '未启动');
const currentCapability = computed(() => pendingTool.value ? authorizationForTool(pendingTool.value.call, 'interactive').capabilities[0] : '只读');
const journalStatus = computed(() => pendingChanges.value?.execution.journalSummary.state ?? '无未完成日志');
const releaseStatus = computed(() => pendingRelease.value ? '等待发送批准' : '本地保留');
const relayOrigin = computed(() => { try { return relayUrl.value ? new URL(relayUrl.value).origin : '离线'; } catch { return '无效中继'; } });
const refreshWorkspace = async (): Promise<void> => { workspace.value = await services.workspace.load(); permission.value = workspace.value ? await services.workspace.getPermission() : 'unavailable'; };
const refreshWorkHistory = async (): Promise<void> => { if (workspace.value) workHistory.value = await services.workspaceHistory.load(workspace.value.handle); };
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
  try { await services.workspaceHistory.clear(workspace.value.handle); workHistory.value = []; recovery.value = null; } catch { historyError.value = '清除工作记录失败。'; }
};
const refreshTabs = async (): Promise<void> => { tabs.value = await services.tab.listConnectedTabs(); selectedTabId.value = tabs.value.length === 1 ? tabs.value[0].id : null; };
const isCurrentAuthorityGeneration = (generation: number): boolean => generation === authorityGeneration;
const stopAndRevoke = async (reason = 'USER_STOP'): Promise<number> => {
  const generation = ++authorityGeneration;
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
  const selection = services.workspace.selectDirectory();
  await reset;
  workspace.value = await selection;
  permission.value = await services.workspace.getPermission();
  historyEnabled.value = false;
  recovery.value = null;
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
}, (context) => services.consent.hasValid('workspace-networked', context));
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
  onState: (state) => { agentState.value = state; },
  onDelta: (delta) => { terminalChunks.value.push(delta); },
});
const approveTool = (): void => { const pending = pendingTool.value; if (pending) pending.finish(authorizationForTool(pending.call, 'interactive')); };
const rejectTool = (): void => pendingTool.value?.finish(null);
const decideChanges = (decision: ChangeDecision): void => pendingChanges.value?.finish(decision);
const decideRelease = (approved: boolean): void => pendingRelease.value?.finish(approved);
const stopTask = (): void => { void stopAndRevoke('USER_STOP'); };
const resumeRecovery = async (): Promise<void> => {
  const checkpoint = recovery.value;
  if (!checkpoint) return;
  recoveryError.value = null;
  if (!await enableWorkHistory()) { recoveryError.value = '恢复任务需要重新确认对 .session 的写入授权。'; return; }
  const tab = tabs.value.find((candidate) => candidate.id === selectedTabId.value);
  if (!tab || tab.provider !== checkpoint.provider) { recoveryError.value = `请选择 ${checkpoint.provider} 页面后再恢复。`; return; }
  await submit(`继续此前被重启中断的任务。\n原任务：${checkpoint.task}\n已保存进度：${checkpoint.summary}\n请检查当前工作区后继续，不要假定未确认的工具调用已经执行。`);
};
const submit = async (prompt: string): Promise<void> => {
  if (!canSubmit.value || selectedTabId.value === null || !workspace.value || !orchestrator) return;
  busy.value = true;
  messages.value.push(prompt);
  const selected = tabs.value.find((tab) => tab.id === selectedTabId.value);
  const guardedTask = historyGuard.redact({ text: prompt, exitCode: null, truncated: false, durationMs: 0 }).redactedText;
  if (historyEnabled.value && selected) {
    try {
      const checkpoint: RecoveryCheckpoint = { updatedAt: Date.now(), provider: selected.provider, task: guardedTask, phase: 'running', summary: '任务已启动；重启后请确认恢复。' };
      await services.workspaceHistory.saveRecovery(workspace.value.handle, checkpoint);
      recovery.value = checkpoint;
    } catch { historyError.value = '保存恢复状态失败；任务仍可正常运行。'; }
  }
  const outcome = await orchestrator.run(prompt, {
    tabId: selectedTabId.value,
    executionMode: executionMode.value,
    consentContext: { workspaceId: workspace.value.workspaceId, relayUrl: networkMode.value === 'wisp' ? activeRelayUrl.value : null },
    customInstructions: customInstructions.value,
  });
  if (outcome.text) messages.value.push(outcome.text);
  else if (outcome.code) messages.value.push(`任务结束：${outcome.code}`);
  try {
    if (historyEnabled.value && selected) {
      const result = historyGuard.redact({ text: outcome.text || outcome.code || '', exitCode: null, truncated: false, durationMs: 0 }).redactedText;
      await services.workspaceHistory.append(workspace.value.handle, { id: crypto.randomUUID(), createdAt: Date.now(), provider: selected.provider, task: guardedTask, outcome: result, status: outcome.code ? 'failed' : 'completed' });
      await services.workspaceHistory.saveRecovery(workspace.value.handle, { updatedAt: Date.now(), provider: selected.provider, task: guardedTask, phase: outcome.state, summary: result });
      recovery.value = null;
      await refreshWorkHistory();
    }
  } catch { /* A task result remains usable when optional local history cannot be written. */ }
  busy.value = false;
};
onMounted(() => {
  void refreshWorkspace().then(async () => { await Promise.all([refreshWorkHistory(), refreshRecovery()]); }).catch(() => { workHistory.value = []; recovery.value = null; });
  void refreshTabs().catch(() => { tabs.value = []; selectedTabId.value = null; });
  void services.relaySettings.load().then((saved) => { if (saved) { savedRelayUrl.value = saved; relayUrl.value = saved; } }).catch(() => { relayError.value = 'WISP relay URL 读取失败'; });
  void services.agentSettings.load().then((saved) => { customInstructions.value = saved; }).catch(() => { customInstructionsError.value = '自定义 Agent 指令读取失败'; });
  void services.themeSettings?.load().then((saved) => { themeMode.value = saved; }).catch(() => {});
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (media) { systemDark.value = media.matches; media.addEventListener?.('change', (event) => { systemDark.value = event.matches; }); }
});
const setTheme = async (mode: ThemeMode): Promise<void> => { themeMode.value = await services.themeSettings?.save(mode) ?? mode; };
</script>
<template>
  <main class="side-panel" :data-theme="effectiveTheme">
    <header class="app-header"><span class="brand-mark">⌘</span><strong>kcode</strong><button class="more-button" aria-label="会话设置" @click="settingsOpen = true">•••</button></header>
    <div class="context-pills"><span><i :class="tabs.length ? 'online' : ''"></i>{{ tabs.length ? '聊天已连接' : '未连接聊天' }}</span><button @click="chooseDirectory">{{ workspace ? '/work · 项目' : '选择工作目录' }}</button><span>{{ executionMode === 'auto' ? 'Auto' : '确认每步' }}</span></div>
    <dialog :open="settingsOpen" aria-label="会话设置"><header><strong>会话设置</strong><button aria-label="关闭设置" @click="settingsOpen = false">×</button></header><p>风险能力始终需要明确确认。</p><label>主题<select :value="themeMode" @change="setTheme(($event.target as HTMLSelectElement).value as ThemeMode)"><option value="system">跟随浏览器</option><option value="light">亮色</option><option value="dark">暗色</option></select></label><div class="workspace-controls"><label>VM 内存<select :value="memoryProfile" @change="requestMemoryProfile"><option value="standard">标准（256 MiB）</option><option value="high">高内存（512 MiB）</option></select></label><label><input :checked="autoRequested" type="checkbox" @change="requestHighRiskMode($event, 'auto')">启用 Auto</label><label><input :checked="networkRequested" type="checkbox" @change="requestHighRiskMode($event, 'workspace-networked')">连接工作区网络</label><label v-if="tabs.length > 1">聊天页面<select v-model="selectedTabId"><option :value="null">请选择</option><option v-for="tab in tabs" :key="tab.id" :value="tab.id">{{ tab.provider }}：{{ tab.title }}</option></select></label></div><NetworkSettings v-model="relayUrl" :saved-url="savedRelayUrl" :error="relayError" @update:model-value="changeRelayUrl" @save="saveRelayUrl" @clear="clearRelayUrl" /><AgentSettings v-model="customInstructions" :error="customInstructionsError" @save="saveCustomInstructions" @clear="clearCustomInstructions" /><section aria-label="工作记录"><button v-if="!historyEnabled" type="button" @click="enableWorkHistory">启用工作记录（写入 .session）</button><button v-else type="button" @click="clearWorkHistory">清除工作记录</button><p v-if="historyError" role="alert">{{ historyError }}</p><p v-if="workHistory.length === 0">暂无工作记录</p><p v-for="record in workHistory" :key="record.id">{{ record.provider }} · {{ record.status }} · {{ record.task }} · {{ record.outcome }}</p></section></dialog>
    <section v-if="recovery?.phase === 'running'" aria-label="恢复上次任务"><p>上次任务在 {{ recovery.updatedAt }} 保存：{{ recovery.task }}</p><p>进度：{{ recovery.summary }}</p><p v-if="recoveryError">{{ recoveryError }}</p><button type="button" @click="resumeRecovery">恢复任务</button></section>
    <section v-if="showMemoryProfileWarning" role="dialog" aria-label="高内存冷启动确认"><p>切换到 512 MiB 会冷重启虚拟机，丢失活动命令、工作区挂载、事务和网络状态，并增加浏览器内存占用。</p><button @click="confirmHighMemoryProfile">确认切换到 512 MiB</button><button @click="cancelMemoryProfileChange">取消</button></section>
    <AutoModeStatus :workspace-name="workspace?.workspaceId ?? '未选择目录'" :relay-origin="relayOrigin" :auto="executionMode === 'auto'" :network="networkMode === 'wisp'" @stop="stopTask" />
    <RiskConsentDialog v-if="showConsent" :auto="autoRequested" :network="networkRequested" @accept="acceptConsent" @cancel="rejectConsent" />
    <ToolApproval v-if="pendingTool" :call="pendingTool.call" :workspace-name="workspace?.workspaceId ?? '未选择目录'" :network="networkMode === 'wisp' ? relayOrigin : 'offline'" @approve-tool="approveTool" @reject="rejectTool" />
    <ChangeReview v-if="pendingChanges" :summary="pendingChanges.execution.journalSummary" @accept="decideChanges('accept')" @rollback="decideChanges('rollback')" />
    <ResultRelease v-if="pendingRelease" :result="pendingRelease.result" @release="decideRelease(true)" @cancel="decideRelease(false)" />
    <section class="panel-content"><section v-if="messages.length === 0" class="welcome"><h1>今天想完成什么？</h1><p>我会在需要时请求工具权限。</p><div><button @click="submit('了解 /work 中的项目结构')">了解项目结构</button><button @click="submit('实现一个功能并验证')">实现一个功能</button></div></section><ChatFeed :messages="messages" /><TerminalPane :chunks="terminalChunks" /></section>
    <TaskComposer :disabled="!canSubmit" @submit="submit" @cancel="stopTask" />
  </main>
</template>
