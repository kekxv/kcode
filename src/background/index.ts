import { PortRouter } from './port-router';

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

export const portRouter = new PortRouter();
portRouter.register();
