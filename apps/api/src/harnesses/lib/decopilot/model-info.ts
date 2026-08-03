/** Request-shape model descriptor (client → dispatch). Distinct from the
 *  provider-shape `ModelInfo` in `studio-provider.ts`. Portable harness leaf:
 *  no `@/*`, no cluster imports — the web-search / generate-image tools
 *  consume it on both cluster and desktop. */
export interface ModelInfo {
  id: string;
  title?: string;
  capabilities?: {
    vision?: boolean;
    text?: boolean;
    tools?: boolean;
    reasoning?: boolean;
    file?: boolean;
  };
  provider?: string | null;
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}
