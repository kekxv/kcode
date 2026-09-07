import { PortRouter } from './port-router';

const PANEL_OWNER_KEY = 'kcode.side-panel-owner-tab';
let panelOwnerTabId: number | undefined;

const isTabId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const configurePanel = async (): Promise<void> => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  // A default disabled option means tabs that have never been explicitly
  // selected cannot reveal kcode's panel.
  await chrome.sidePanel.setOptions({ enabled: false });
  const stored = await chrome.storage.session.get(PANEL_OWNER_KEY);
  const owner = stored[PANEL_OWNER_KEY];
  if (!isTabId(owner)) return;
  panelOwnerTabId = owner;
  await chrome.sidePanel.setOptions({ tabId: owner, path: 'src/sidepanel/index.html', enabled: true });
};

void configurePanel().catch((error: unknown) => console.error('Failed to configure the kcode side panel.', error));

const openPanelForTab = (tab: chrome.tabs.Tab): void => {
  if (!isTabId(tab.id)) return;
  const nextOwner = tab.id;
  if (panelOwnerTabId !== undefined && panelOwnerTabId !== nextOwner) {
    void chrome.sidePanel.setOptions({ tabId: panelOwnerTabId, enabled: false })
      .catch((error: unknown) => console.error('Failed to hide kcode in the previous tab.', error));
  }
  panelOwnerTabId = nextOwner;
  // Both calls must be issued synchronously from the action click. Awaiting
  // setOptions loses Chrome's user-activation token before sidePanel.open.
  void chrome.sidePanel.setOptions({ tabId: nextOwner, path: 'src/sidepanel/index.html', enabled: true })
    .catch((error: unknown) => console.error('Failed to enable kcode in the selected tab.', error));
  void chrome.sidePanel.open({ tabId: nextOwner })
    .catch((error: unknown) => console.error('Failed to open kcode in the selected tab.', error));
  void chrome.storage.session.set({ [PANEL_OWNER_KEY]: nextOwner });
};

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.action.onClicked.addListener(openPanelForTab);

export const portRouter = new PortRouter();
portRouter.register();
