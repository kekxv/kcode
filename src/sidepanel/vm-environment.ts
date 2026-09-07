import { VM_MEMORY_PROFILES } from '../types/protocol';
import type { AgentRunOptions } from '../types/tools';

/** Base image facts from vm/alpine/Dockerfile plus the active session configuration.
 * This describes the configured guest, not a live probe or proof of successful boot.
 */
export const vmEnvironmentPrompt = (options: AgentRunOptions): string => [
  '## Current VM environment',
  'The tools run in a browser-hosted v86 VM, separate from the host computer and the chat provider sandbox. The VM starts lazily on the first tool; this description is configuration, not evidence that it has booted.',
  'Base image: Alpine Linux 3.21, Linux, 32-bit x86 (i386), musl libc. Use Linux paths and i386-compatible binaries; x86_64/ARM binaries and glibc-only packages may not work.',
  `Configured RAM: ${VM_MEMORY_PROFILES[options.memoryProfile ?? 'standard'] / (1024 * 1024)} MiB. CPU execution is emulated; keep builds, dependency trees and memory usage small.`,
  'Shell: /bin/sh (BusyBox ash). The tool named bash runs commands in this shell; GNU Bash is not preinstalled. Prefer POSIX sh syntax and BusyBox-compatible flags. Avoid exit/exec or changing shell traps/options that would break the persistent tool session.',
  'Base tools: BusyBox utilities, git, python3 (3.12), node (22), npm (10), curl, CA certificates, and apk. Bash, GNU coreutils, ripgrep, compilers, a desktop browser and GPU tooling are not guaranteed. Check command -v and --version before relying on extra tools; use apk rather than apt if installation is needed and permitted.',
  'The selected host project is mounted at /work through a filesystem bridge. Keep project files there. Guest /tmp is temporary scratch space, not a host directory. OS paths such as /etc belong to the guest; they do not provide access to the host filesystem.',
  'The shell current directory, environment variables and guest state persist between tool calls while this VM remains alive. Use cd /work explicitly when needed. VM reset/termination can discard temporary files, installed packages and processes; confirm state again after restarting.',
  options.consentContext.relayUrl === null
    ? 'Network: offline; the VM has no network device. Downloads, remote git operations, npm/apk installs and external URLs cannot be assumed to work. Prefer preinstalled tools and local project dependencies.'
    : 'Network: WISP outbound TCP is configured and still depends on valid session authorization and relay availability. Test connectivity before installing packages. The model website having Internet access does not establish VM connectivity.',
  'VM localhost belongs to the guest. A dev server started there is not automatically exposed to the host browser; do not claim a preview URL is accessible without verification. No browser/screenshot tool is provided by this bridge.',
  'Execution limits: one tool at a time; shell commands default to 120000 ms and may request timeoutMs from 1000 to 600000. Model-response waiting has no fixed timeout; shell command limits still apply.',
  'Size limits: command text 32 KiB; tool envelope 300 KiB; read_file maxBytes up to 1 MiB; write_file content up to 1 MiB but must also fit the envelope. Split large edits into smaller tool calls.',
  'Output is bounded: shell retained output up to 1 MiB, total streamed output up to 8 MiB; processed results sent to the model may be truncated at 256 KiB. Inspect truncated and exit_code, request targeted output, and never assume omitted output is empty.',
  'Workspace mutations use a journal: per-file limit 16 MiB and per-transaction limit 100 MiB. Large dependency installs may exceed these limits; avoid bulk generated files and prefer focused checks.',
].join('\n');
