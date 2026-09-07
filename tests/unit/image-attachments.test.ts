// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';
import TaskComposer from '../../src/sidepanel/components/TaskComposer.vue';
import { isContentCommand, isSidePanelCommand } from '../../src/types/protocol';
import { uploadImages } from '../../src/content/adapters/image-upload';
const image = { name: 'screen.png', dataUrl: 'data:image/png;base64,aGVsbG8=' };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('image attachments', () => {
  it('permits bounded image envelopes without increasing the plain-text message limit', () => {
    const command = { protocolVersion: 1, kind: 'CONTENT_SEND_PROMPT', requestId: 'image_1', prompt: '看图', images: [image] };
    expect(isContentCommand(command)).toBe(true);
    expect(isSidePanelCommand({ ...command, targetTabId: 7 })).toBe(true);
    expect(isContentCommand({ ...command, images: [image, image, image, image] })).toBe(false);
    expect(isContentCommand({ ...command, images: [{ ...image, dataUrl: 'https://example.com/picture.png' }] })).toBe(false);
    expect(isContentCommand({ ...command, prompt: 'x'.repeat(400 * 1024) })).toBe(false);
    expect(isContentCommand({ ...command, images: [{ ...image, dataUrl: 'data:image/svg+xml;base64,aGVsbG8=' }] })).toBe(false);
  });
  it('previews a pasted image, permits image-only submission, and clears the attachment draft', async () => {
    const { emitted } = render(TaskComposer, { props: { disabled: false, hint: null } });
    const file = new File(['hello'], 'screen.png', { type: 'image/png' });
    await fireEvent.paste(screen.getByRole('textbox', { name: '任务' }), { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } });
    await screen.findByAltText('screen.png');
    await fireEvent.click(screen.getByRole('button', { name: '开始任务' }));
    expect(emitted().submit).toEqual([['请分析这些图片。', [image]]]);
    expect(screen.queryByAltText('screen.png')).toBeNull();
  });
  it('waits for a page attachment preview after native paste and cancels cleanly', async () => {
    vi.useFakeTimers();
    class Transfer { items = { add: vi.fn() }; }
    class Paste extends Event { clipboardData: unknown; constructor(type: string, init: ClipboardEventInit) { super(type, init); this.clipboardData = init.clipboardData; } }
    vi.stubGlobal('DataTransfer', Transfer); vi.stubGlobal('ClipboardEvent', Paste);
    document.body.innerHTML = '<main><textarea></textarea><div id="previews"></div></main>';
    const main = document.querySelector('main')!; const composer = document.querySelector('textarea')!;
    composer.addEventListener('paste', () => { setTimeout(() => { document.querySelector('#previews')!.textContent = image.name; }, 200); });
    const upload = uploadImages(document, main, composer, [image], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1200);
    await expect(upload).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const abort = new AbortController();
    const cancelled = uploadImages(document, main, composer, [image], abort.signal);
    const assertion = expect(cancelled).rejects.toMatchObject({ code: 'CONTENT_ABORTED' });
    abort.abort(); await assertion;
  });
  it('does not report successful upload when the page ignores paste', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('DataTransfer', class { items = { add: vi.fn() }; });
    vi.stubGlobal('ClipboardEvent', Event);
    document.body.innerHTML = '<main><textarea></textarea></main>';
    const upload = uploadImages(document, document.querySelector('main')!, document.querySelector('textarea')!, [image], new AbortController().signal);
    const assertion = expect(upload).rejects.toMatchObject({ code: 'IMAGE_UPLOAD_UNCONFIRMED' });
    await vi.advanceTimersByTimeAsync(21000); await assertion;
  });
});
