export type WorkspacePath = readonly string[];

const invalidPath = (): never => {
  throw new Error('INVALID_WORKSPACE_PATH');
};

/**
 * Produces workspace-relative path segments only. Callers must walk a
 * FileSystemDirectoryHandle one segment at a time rather than constructing a
 * host filesystem path.
 */
export const normalizeWorkspacePath = (path: string): WorkspacePath => {
  if (path.includes('\0')) return invalidPath();

  const normalizedSeparators = path.replaceAll('\\', '/');
  if (
    normalizedSeparators.startsWith('/')
    || /^[A-Za-z]:\//.test(normalizedSeparators)
    || normalizedSeparators.endsWith('/')
  ) return invalidPath();

  const segments: string[] = [];
  for (const segment of normalizedSeparators.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return invalidPath();
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) return invalidPath();
  return segments;
};
