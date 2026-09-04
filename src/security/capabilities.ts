import type { WorkspaceCapability, WorkspaceSession } from '../types/protocol';

export const hasWorkspaceCapability = (
  session: WorkspaceSession,
  capability: WorkspaceCapability,
): boolean => session.capabilities.includes(capability);

export const canUseNetwork = (session: WorkspaceSession): boolean =>
  session.network.mode === 'wisp';
