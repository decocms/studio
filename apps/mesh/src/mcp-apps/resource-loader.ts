import type { McpUiResourceCsp } from "./types.ts";
import { RESOURCE_MIME_TYPE } from "./types.ts";

export interface UIResourceContent {
  html: string;
  mimeType: string;
  uri: string;
  csp?: McpUiResourceCsp;
}

export class UIResourceLoadError extends Error {
  public readonly uri: string;
  public readonly reason: string;

  constructor(uri: string, reason: string, cause?: Error) {
    super(`Failed to load UI resource "${uri}": ${reason}`);
    this.name = "UIResourceLoadError";
    this.uri = uri;
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

export interface ResourceLoaderOptions {
  cacheTTL?: number;
  maxCacheSize?: number;
}

interface CacheEntry {
  content: UIResourceContent;
  timestamp: number;
}

export type ReadResourceFn = (uri: string) => Promise<{
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    _meta?: {
      ui?: {
        csp?: McpUiResourceCsp;
      };
    };
  }>;
}>;

function extractCsp(
  meta: { ui?: { csp?: McpUiResourceCsp } } | undefined,
): McpUiResourceCsp | undefined {
  const csp = meta?.ui?.csp;
  if (!csp || typeof csp !== "object") return undefined;
  return csp;
}

export class UIResourceLoader {
  private cache = new Map<string, CacheEntry>();
  private cacheTTL: number;
  private maxCacheSize: number;

  constructor(options: ResourceLoaderOptions = {}) {
    this.cacheTTL = options.cacheTTL ?? 300_000;
    this.maxCacheSize = options.maxCacheSize ?? 50;
  }

  async load(
    uri: string,
    readResource: ReadResourceFn,
  ): Promise<UIResourceContent> {
    if (this.cacheTTL > 0) {
      const cached = this.cache.get(uri);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.content;
      }
    }

    try {
      const result = await readResource(uri);

      if (!result.contents || result.contents.length === 0) {
        throw new UIResourceLoadError(uri, "No content returned from resource");
      }

      const content = result.contents[0]!;
      if (!content.text) {
        throw new UIResourceLoadError(uri, "Resource content has no text");
      }

      const resourceContent: UIResourceContent = {
        html: content.text,
        mimeType: content.mimeType ?? RESOURCE_MIME_TYPE,
        uri: content.uri ?? uri,
        csp: extractCsp(content._meta),
      };

      if (this.cacheTTL > 0 && this.maxCacheSize > 0) {
        if (this.cache.size >= this.maxCacheSize) {
          const oldestKey = this.cache.keys().next().value;
          if (oldestKey) this.cache.delete(oldestKey);
        }
        this.cache.set(uri, {
          content: resourceContent,
          timestamp: Date.now(),
        });
      }

      return resourceContent;
    } catch (err) {
      if (err instanceof UIResourceLoadError) throw err;
      throw new UIResourceLoadError(
        uri,
        "Resource fetch failed",
        err instanceof Error ? err : undefined,
      );
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  invalidate(uri: string): void {
    this.cache.delete(uri);
  }
}
