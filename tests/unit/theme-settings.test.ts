import { describe, expect, it, vi } from 'vitest';
import { ThemeSettingsStore, effectiveTheme } from '../../src/sidepanel/theme-settings';
describe('theme settings', () => {
  it('falls back to system for invalid persisted values', async () => { const store = new ThemeSettingsStore({ get: vi.fn().mockResolvedValue({ 'kcode.theme': 'violet' }), set: vi.fn() }); await expect(store.load()).resolves.toBe('system'); });
  it('derives dark and light from explicit or system modes', () => { expect(effectiveTheme('system', true)).toBe('dark'); expect(effectiveTheme('light', true)).toBe('light'); expect(effectiveTheme('dark', false)).toBe('dark'); });
});
