import { describe, expect, it } from 'vitest';
import { normalizeWorkspacePath } from '../../src/utils/path';

describe('normalizeWorkspacePath', () => {
  it('returns lexical segments without constructing a host path', () => {
    expect(normalizeWorkspacePath('src\\components/../App.vue')).toEqual(['src', 'App.vue']);
  });

  it.each([
    '../secret',
    '/etc/passwd',
    'C:\\Windows\\System32',
    'src/../../secret',
    'a\0b',
    'src/',
  ])('rejects a path outside the workspace or without a final name: %s', (path) => {
    expect(() => normalizeWorkspacePath(path)).toThrow('INVALID_WORKSPACE_PATH');
  });
});
