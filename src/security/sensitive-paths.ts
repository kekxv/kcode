import type { WorkspacePath } from '../utils/path';

const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];
const SECRET_FILES = new Set(['id_rsa', 'id_ed25519', '.npmrc', '.pypirc']);
const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.azure']);
const ENVIRONMENT_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);

const fold = (segment: string): string => segment.normalize('NFC').toLowerCase();

export const isSensitivePath = (path: WorkspacePath): boolean => {
  const segments = path.map(fold);
  return segments.some((segment, index) => {
    if (SECRET_DIRECTORIES.has(segment) || SECRET_FILES.has(segment)) return true;
    if (segment.startsWith('.env') && !ENVIRONMENT_EXAMPLES.has(segment)) return true;
    if (SECRET_EXTENSIONS.some((extension) => segment.endsWith(extension))) return true;
    return segment === 'gcloud' && segments[index - 1] === '.config';
  });
};
