import { expect, it } from 'vitest';
import { ExecutionSettingsStore } from '../../src/sidepanel/execution-settings';
it.each(['confirm-each', 'auto-write', 'auto'] as const)('retains %s across store instances', async mode => {
  const values: Record<string, unknown> = {};
  const storage = { get: async (key: string) => ({ [key]: values[key] }), set: async (items: Record<string, unknown>) => { Object.assign(values, items); } };
  await new ExecutionSettingsStore(storage).save(mode);
  await expect(new ExecutionSettingsStore(storage).load()).resolves.toBe(mode);
});
it('falls back to manual for invalid stored preferences', async () => {
  await expect(new ExecutionSettingsStore({ get: async () => ({ 'kcode.execution-mode': 'invalid' }), set: async () => {} }).load()).resolves.toBe('confirm-each');
});
