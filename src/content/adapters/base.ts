import type { ImageAttachment } from '../../types/attachments';
export type ResponseAnchor = {
  existingAssistantNodes: ReadonlySet<Element>;
  startedAt: number;
};

export interface SiteAdapter {
  /** Some providers rewrite their same-document conversation URL while streaming a response. */
  readonly allowsSameOriginNavigation?: boolean;
  sendPrompt(prompt: string, signal: AbortSignal, images?: ImageAttachment[]): Promise<ResponseAnchor>;
  watchResponse(
    anchor: ResponseAnchor,
    signal: AbortSignal,
    emitDelta: (delta: string) => void,
  ): Promise<void>;
}

/** Expected site/runtime failures that can be sent through the bounded content Port. */
export class AdapterError extends Error {
  constructor(
    readonly code: 'PROVIDER_RATE_LIMITED' | 'PROVIDER_ERROR' | 'ADAPTER_DOM_CHANGED' | 'CONTENT_ABORTED' | 'CONTENT_RESPONSE_LIMIT' | 'IMAGE_ATTACHMENT_UNSUPPORTED' | 'IMAGE_UPLOAD_UNCONFIRMED',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
