import type { ImageAttachment } from '../../types/attachments';
import { AdapterError } from './base';

const pause = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new AdapterError('CONTENT_ABORTED', 'Image upload cancelled.')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 100);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

/** Use the page's own upload flow, and require new attachment UI before Send. */
export async function uploadImages(document: Document, scope: Element, composer: Element, images: ImageAttachment[], signal: AbortSignal, ready: () => boolean = () => true): Promise<void> {
  if (!images.length) return;
  const before = new Set([...scope.querySelectorAll('img')].map(image => image.getAttribute('src')));
  const beforeText = scope.textContent ?? '';
  const transfer = new DataTransfer();
  for (const image of images) {
    const [header, base64] = image.dataUrl.split(',');
    const type = header!.slice(5, header!.indexOf(';'));
    const bytes = Uint8Array.from(atob(base64!), c => c.charCodeAt(0));
    transfer.items.add(new File([bytes], image.name, { type }));
  }
  const acceptsImages = (input: HTMLInputElement) => !input.disabled && (!input.accept || /image|\.png|\.jpg|\.jpeg|\.webp|\*/i.test(input.accept));
  const local = [...scope.querySelectorAll<HTMLInputElement>('input[type=file]')].filter(acceptsImages);
  const candidates = local.length ? local : [...document.querySelectorAll<HTMLInputElement>('input[type=file]')].filter(acceptsImages);
  if (candidates.length > 1) throw new AdapterError('IMAGE_ATTACHMENT_UNSUPPORTED', '图片上传入口不唯一，请在聊天网页手动附加图片后重试。');
  if (candidates.length === 1) {
    const input = candidates[0]!;
    if (images.length > 1 && !input.multiple) throw new AdapterError('IMAGE_ATTACHMENT_UNSUPPORTED', '当前页面上传入口只支持单张图片。');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    composer.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }
  const deadline = Date.now() + 20_000;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new AdapterError('CONTENT_ABORTED', 'Image upload cancelled.');
    const newPreviews = [...scope.querySelectorAll<HTMLImageElement>('img')].filter(image => !before.has(image.getAttribute('src')) && image.complete && image.naturalWidth > 0);
    const text = scope.textContent ?? '';
    const namesVisible = images.every(image => !beforeText.includes(image.name) && text.includes(image.name));
    const uploading = [...scope.querySelectorAll('[role=progressbar], progress, [aria-busy=true]')].some(node => node.getClientRects().length > 0);
    if ((newPreviews.length >= images.length || namesVisible) && !uploading && ready()) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 800) return;
    } else stableSince = 0;
    await pause(signal);
  }
  throw new AdapterError('IMAGE_UPLOAD_UNCONFIRMED', '未确认图片上传完成，本次未发送文字。请检查聊天网页附件或改用网页手动上传。');
}
