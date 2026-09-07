export type ImageAttachment = { name: string; dataUrl: string };
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const isImageAttachments = (value: unknown): value is ImageAttachment[] =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_IMAGES && value.every(image =>
    image && typeof image === 'object' && Object.keys(image).sort().join(',') === 'dataUrl,name'
    && typeof image.name === 'string' && image.name.length > 0 && image.name.length <= 128
    && typeof image.dataUrl === 'string' && image.dataUrl.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40
    && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl));
