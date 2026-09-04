<script lang="ts">
import type { InjectionKey } from 'vue';
import { normalizeRelayUrl, type ConsentContext } from '../security/risk-consent';
import type { WorkspaceStore } from '../utils/idb-store';
import type { TabClient } from './tab-client';
import type { VMClient } from './vm-client';
export type SidePanelServices = {
  workspace: Pick<WorkspaceStore, 'load' | 'selectDirectory' | 'getPermission' | 'requestReadWrite'>;
  tab: Pick<TabClient, 'listConnectedTabs' | 'sendPrompt'>;
  vm: Pick<VMClient, 'terminate' | 'attachWorkspace' | 'start' | 'exec' | 'subscribe'>;
  consent: { grant(modes: readonly ('auto' | 'workspace-networked')[], context: ConsentContext): Promise<void>; hasValid(mode: 'auto' | 'workspace-networked', context: ConsentContext): Promise<boolean>; revokeAll(): Promise<void> };
};
export const sidePanelServicesKey: InjectionKey<SidePanelServices> = Symbol('sidePanelServices');
</script>
<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import type { StoredWorkspace } from '../utils/idb-store';
import AutoModeStatus from './components/AutoModeStatus.vue';
import ChatFeed from './components/ChatFeed.vue';
import RiskConsentDialog from './components/RiskConsentDialog.vue';
import StatusBar from './components/StatusBar.vue';
import TaskComposer from './components/TaskComposer.vue';
import TerminalPane from './components/TerminalPane.vue';
const services = inject(sidePanelServicesKey);
if (!services) throw new Error('SIDE_PANEL_SERVICES_UNAVAILABLE');
const workspace = ref<StoredWorkspace | null>(null);
const permission = ref<PermissionState | 'unavailable'>('unavailable');
const tabs = ref<Array<{ id: number; title: string }>>([]);
const selectedTabId = ref<number | null>(null);
const executionMode = ref<'confirm-each' | 'auto'>('confirm-each');
const networkMode = ref<'offline' | 'wisp'>('offline');
const relayUrl = ref(''); const activeRelayUrl = ref<string | null>(null); const autoRequested = ref(false); const networkRequested = ref(false); const showConsent = ref(false);
const messages = ref<string[]>([]); const terminalChunks = ref<string[]>([]); const busy = ref(false);
const directoryStatus = computed(() => permission.value === 'granted' ? '可读' : permission.value === 'prompt' ? '需要授权' : '未选择');
const webpageStatus = computed(() => tabs.value.length === 0 ? '未连接' : tabs.value.length === 1 ? '已连接' : '请选择页面');
const canSubmit = computed(() => permission.value === 'granted' && selectedTabId.value !== null && !busy.value);
const relayOrigin = computed(() => { try { return relayUrl.value ? new URL(relayUrl.value).origin : '离线'; } catch { return '无效中继'; } });
const refreshWorkspace = async (): Promise<void> => { workspace.value = await services.workspace.load(); permission.value = workspace.value ? await services.workspace.getPermission() : 'unavailable'; };
const refreshTabs = async (): Promise<void> => { tabs.value = await services.tab.listConnectedTabs(); selectedTabId.value = tabs.value.length === 1 ? tabs.value[0].id : null; };
const stopAndRevoke = async (reason = 'USER_STOP'): Promise<void> => { busy.value = false; services.vm.terminate(reason); executionMode.value = 'confirm-each'; networkMode.value = 'offline'; activeRelayUrl.value = null; autoRequested.value = false; networkRequested.value = false; showConsent.value = false; await services.consent.revokeAll(); };
const chooseDirectory = async (): Promise<void> => { await stopAndRevoke(); workspace.value = await services.workspace.selectDirectory(); permission.value = await services.workspace.getPermission(); };
const requestHighRiskMode = (): void => { const requestedAuto = autoRequested.value; const requestedNetwork = networkRequested.value; void stopAndRevoke().then(() => { autoRequested.value = requestedAuto; networkRequested.value = requestedNetwork; showConsent.value = requestedAuto || requestedNetwork; }); };
const rejectConsent = (): void => { void stopAndRevoke(); };
const changeRelayUrl = (event: Event): void => {
  const next = (event.target as HTMLInputElement).value;
  relayUrl.value = next;
  if (networkMode.value !== 'wisp') return;
  try {
    if (normalizeRelayUrl(next) !== activeRelayUrl.value) void stopAndRevoke('RELAY_URL_CHANGED');
  } catch {
    void stopAndRevoke('RELAY_URL_CHANGED');
  }
};
const acceptConsent = async (): Promise<void> => {
  const selected = workspace.value; if (!selected) return rejectConsent();
  const modes = [...(autoRequested.value ? ['auto' as const] : []), ...(networkRequested.value ? ['workspace-networked' as const] : [])];
  let normalizedRelayUrl: string | null = null;
  try { normalizedRelayUrl = networkRequested.value ? normalizeRelayUrl(relayUrl.value) : null; } catch { return stopAndRevoke('RELAY_URL_CHANGED'); }
  const context = { workspaceId: selected.workspaceId, relayUrl: normalizedRelayUrl };
  const writePermission = autoRequested.value ? services.workspace.requestReadWrite() : Promise.resolve<'granted'>('granted');
  const grant = services.consent.grant(modes, context);
  try { const [result] = await Promise.all([writePermission, grant]); if (result !== 'granted') throw new Error('DIRECTORY_PERMISSION_DENIED'); activeRelayUrl.value = normalizedRelayUrl; executionMode.value = autoRequested.value ? 'auto' : 'confirm-each'; networkMode.value = networkRequested.value ? 'wisp' : 'offline'; showConsent.value = false; } catch { await stopAndRevoke(); }
};
const submit = async (prompt: string): Promise<void> => { if (!canSubmit.value || selectedTabId.value === null) return; busy.value = true; messages.value.push(prompt); try { await services.tab.sendPrompt(selectedTabId.value, prompt, { onDelta: (delta) => { messages.value.push(delta); terminalChunks.value.push(delta); } }); } finally { busy.value = false; } };
onMounted(() => { void refreshWorkspace().catch(() => { permission.value = 'unavailable'; }); void refreshTabs().catch(() => { tabs.value = []; selectedTabId.value = null; }); });
</script>
<template>
  <main class="side-panel">
    <StatusBar :directory="directoryStatus" vm="未启动" :webpage="webpageStatus" :execution="executionMode" :network="networkMode" capability="只读" journal="无未完成日志" release="本地保留" />
    <div class="workspace-controls"><button @click="chooseDirectory">选择工作目录</button><label><input v-model="autoRequested" type="checkbox" @change="requestHighRiskMode">启用 Auto</label><label><input v-model="networkRequested" type="checkbox" @change="requestHighRiskMode">连接工作区网络</label><label v-if="networkRequested">WISP relay URL<input :value="relayUrl" type="url" placeholder="wss://relay.example/path" @input="changeRelayUrl"></label><label v-if="tabs.length > 1">DeepSeek 页面<select v-model="selectedTabId"><option :value="null">请选择</option><option v-for="tab in tabs" :key="tab.id" :value="tab.id">{{ tab.title }}</option></select></label></div>
    <AutoModeStatus :workspace-name="workspace?.workspaceId ?? '未选择目录'" :relay-origin="relayOrigin" :auto="executionMode === 'auto'" :network="networkMode === 'wisp'" @stop="stopAndRevoke" />
    <RiskConsentDialog v-if="showConsent" :auto="autoRequested" :network="networkRequested" @accept="acceptConsent" @cancel="rejectConsent" />
    <section class="panel-content"><ChatFeed :messages="messages" /><TerminalPane :chunks="terminalChunks" /></section>
    <TaskComposer :disabled="!canSubmit" @submit="submit" @cancel="stopAndRevoke" />
  </main>
</template>
