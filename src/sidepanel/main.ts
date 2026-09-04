import { createApp } from 'vue';
import { RiskConsentStore } from '../security/risk-consent';
import { WorkspaceStore } from '../utils/idb-store';
import App from './App.vue';
import { sidePanelServicesKey } from './App.vue';
import { TabClient } from './tab-client';
import { VMClient } from './vm-client';
import './styles.css';

const app = createApp(App);
app.provide(sidePanelServicesKey, { workspace: new WorkspaceStore(), tab: new TabClient(), vm: new VMClient(), consent: new RiskConsentStore() });
app.mount('#app');
