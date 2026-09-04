import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isContentEvent,
  isSidePanelCommand,
  isVMEvent,
  isVMRequest,
} from '../../src/types/protocol';

afterEach(() => vi.unstubAllGlobals());

describe('Chrome Port protocol guards', () => {
  it('accepts only a bounded, exact side panel command shape', () => {
    expect(isSidePanelCommand({
      protocolVersion: 1,
      kind: 'CONTENT_SEND_PROMPT',
      requestId: 'req_1-A',
      targetTabId: 17,
      prompt: 'hello',
    })).toBe(true);
    expect(isSidePanelCommand({
      protocolVersion: 1,
      kind: 'CONTENT_SEND_PROMPT',
      requestId: 'req-1',
      targetTabId: 17,
      prompt: 'hello',
      callback: () => undefined,
    })).toBe(false);
    expect(isSidePanelCommand({
      protocolVersion: 1,
      kind: 'CONTENT_SEND_PROMPT',
      requestId: '../req',
      targetTabId: 17,
      prompt: 'hello',
    })).toBe(false);
    expect(isSidePanelCommand({
      protocolVersion: 2,
      kind: 'CONTENT_SEND_PROMPT',
      requestId: 'req-1',
      targetTabId: 17,
      prompt: 'hello',
    })).toBe(false);
  });

  it('rejects prompts over 384 KiB measured as UTF-8', () => {
    expect(isSidePanelCommand({
      protocolVersion: 1,
      kind: 'CONTENT_SEND_PROMPT',
      requestId: 'req-1',
      targetTabId: 17,
      prompt: 'a'.repeat(384 * 1024 + 1),
    })).toBe(false);
    expect(isSidePanelCommand({
      protocolVersion: 1,
      kind: 'CONTENT_SEND_PROMPT',
      requestId: 'req-1',
      targetTabId: 17,
      prompt: '界'.repeat(128 * 1024 + 1),
    })).toBe(false);
  });

  it('rejects oversized deltas and forged directory handles', () => {
    expect(isContentEvent({
      protocolVersion: 1,
      kind: 'CONTENT_RESPONSE_DELTA',
      requestId: 'req-1',
      delta: 'a'.repeat(32 * 1024 + 1),
    })).toBe(false);
    expect(isVMRequest({
      kind: 'VM_ATTACH_WORKSPACE',
      requestId: 'req-1',
      handle: { kind: 'directory', name: 'forged' },
    })).toBe(false);
  });

  it('accepts only a branded directory handle in worker requests', () => {
    class TestDirectoryHandle {}
    vi.stubGlobal('FileSystemDirectoryHandle', TestDirectoryHandle);
    expect(isVMRequest({
      kind: 'VM_ATTACH_WORKSPACE',
      requestId: 'req-1',
      handle: new TestDirectoryHandle(),
    })).toBe(true);
  });

  it('validates every VM event variant with exact keys and scalar bounds', () => {
    expect(isVMEvent({ kind: 'VM_READY', requestId: 'req-1' })).toBe(true);
    expect(isVMEvent({ kind: 'VM_RESULT', requestId: 'req-1', output: 'ok', exitCode: 0 })).toBe(true);
    expect(isVMEvent({ kind: 'VM_ERROR', requestId: 'req-1', code: 'VM_FAILURE', message: 'failed' })).toBe(true);
    expect(isVMEvent({ kind: 'VM_RESULT', requestId: 'req-1', output: 'ok', exitCode: 1.5 })).toBe(false);
    expect(isVMEvent({ kind: 'VM_ERROR', requestId: 'req-1', code: 'bad code', message: 'failed' })).toBe(false);
    expect(isVMEvent({ kind: 'VM_READY', requestId: 'req-1', extra: true })).toBe(false);
  });
});
