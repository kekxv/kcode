export type ResponseAnchor = {
  existingAssistantNodes: ReadonlySet<Element>;
  startedAt: number;
};

export interface SiteAdapter {
  sendPrompt(prompt: string, signal: AbortSignal): Promise<ResponseAnchor>;
  watchResponse(
    anchor: ResponseAnchor,
    signal: AbortSignal,
    emitDelta: (delta: string) => void,
  ): Promise<void>;
}

/** Expected site/runtime failures that can be sent through the bounded content Port. */
export class AdapterError extends Error {
  constructor(
    readonly code: 'ADAPTER_DOM_CHANGED' | 'CONTENT_ABORTED' | 'CONTENT_RESPONSE_LIMIT',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
