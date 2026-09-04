import { describe, expect, it } from 'vitest';
import {
  isContentEvent,
  isSidePanelCommand,
  isVMRequest,
} from '../../src/types/protocol';

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

  it('rejects oversized deltas and VM requests with unexpected handles', () => {
    expect(isContentEvent({
      protocolVersion: 1,
      kind: 'CONTENT_RESPONSE_DELTA',
      requestId: 'req-1',
      delta: 'a'.repeat(32 * 1024 + 1),
    })).toBe(false);
    expect(isVMRequest({
      kind: 'VM_ATTACH_WORKSPACE',
      requestId: 'req-1',
      handle: { name: 'not a directory handle' },
      extra: true,
    })).toBe(false);
  });
});
