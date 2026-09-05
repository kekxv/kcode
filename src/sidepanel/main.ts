import { createApp } from 'vue';
import { RiskConsentStore } from '../security/risk-consent';
import { WorkspaceStore } from '../utils/idb-store';
import App from './App.vue';
import { sidePanelServicesKey } from './App.vue';
import { TabClient } from './tab-client';
import { VMClient } from './vm-client';
import { RelaySettingsStore } from './relay-settings';
import { AgentSettingsStore } from './agent-settings';
import { WorkspaceHistoryStore } from './workspace-history';
import './styles.css';
import { ThemeSettingsStore } from './theme-settings';

const app = createApp(App);
app.provide(sidePanelServicesKey, { workspace: new WorkspaceStore(), tab: new TabClient(), vm: new VMClient(), consent: new RiskConsentStore(), relaySettings: new RelaySettingsStore(), agentSettings: new AgentSettingsStore(), workspaceHistory: new WorkspaceHistoryStore(), themeSettings: new ThemeSettingsStore() });
app.mount('#app');
