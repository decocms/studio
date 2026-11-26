/**
 * What the engine needs from the outside world. In the Worker these were
 * Cloudflare bindings and HTTP calls back to Studio; here each one is a port
 * the Studio side implements (the org's AI providers, a sandbox browser, the
 * git providers, object storage, the org's BigQuery connection, analytics).
 */

import type { UxDevice } from "./types.ts";

/**
 * The class of model a call needs: `thinking` for judgement over images and
 * long evidence, `smart` for checking numbers and text. Each maps to the org's
 * chat tier of the same name.
 */
export type LlmTier = "smart" | "thinking";

/** Token counts the provider billed for one call. */
export interface LlmUsage {
  /** The provider that served the call (`deco`, `openrouter`, …). */
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** What the provider says the call cost; absent when it does not say. */
  costUsd?: number;
}

/** A labelled image or text block sent after the user prompt, in order. */
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export interface LlmRequest {
  tier: LlmTier;
  systemPrompt: string;
  userPrompt: string;
  contentParts?: LlmContentPart[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * One chat completion; resolves to the model's text. Rejects when the answer
 * is empty or was cut at `maxTokens`; `onUsage` hears every billed call,
 * those included.
 */
export type Llm = (
  request: LlmRequest,
  onUsage?: (usage: LlmUsage) => void,
) => Promise<string>;

/** The browser itself failed (crashed, went away), not the page it was showing. */
export class BrowserSessionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserSessionError";
  }
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

/** CSS px in document coordinates; `scale` shrinks the image. */
export interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}

/**
 * A tab emulating one device. Every call that reaches the page also refreshes
 * `url()` and `blockedRequests()`.
 */
export interface BrowserPage {
  readonly viewport: Viewport;
  /** The page's URL as of the last call. */
  url(): string;
  /**
   * Navigates and waits until at most two requests stay in flight for 500 ms.
   * A navigation that fails or never settles resolves with `error`; only the
   * browser failing rejects.
   */
  goto(
    url: string,
    timeoutMs: number,
  ): Promise<{ status: number | null; error: string | null }>;
  reload(timeoutMs: number): Promise<void>;
  /** `fn` is serialized and run in the page: it may use nothing from outside its body. */
  evaluate<A extends unknown[], R>(
    fn: (...args: A) => R,
    ...args: A
  ): Promise<Awaited<R>>;
  /** JPEG. Without `clip`, what the viewport shows. */
  screenshot(opts: {
    quality: number;
    clip?: ScreenshotClip;
    captureBeyondViewport?: boolean;
  }): Promise<Uint8Array>;
  /** The only pointer movement there is: no touch, no button press. */
  mouseMove(x: number, y: number, steps: number): Promise<void>;
  /**
   * Clicks the point and waits up to `settleMs` for a navigation; returns the
   * URL of a main-frame navigation requested meanwhile, finished or not.
   */
  click(
    x: number,
    y: number,
    settleMs: number,
  ): Promise<{ navigation: string | null }>;
  /** Requests `blockRequest` aborted on this page so far. */
  blockedRequests(): number;
  close(): Promise<void>;
}

export interface BrowserPort {
  /**
   * `blockRequest` decides, per request, which ones are aborted (with service
   * workers bypassed); it is serialized like a page script.
   */
  newPage(
    device: UxDevice,
    opts?: { blockRequest?: (url: string) => boolean },
  ): Promise<BrowserPage>;
  /**
   * A plain GET from where the browser runs, never from Studio: the hosts
   * are the store's and its competitors'. Rejects when nothing answered.
   */
  fetch(
    url: string,
    opts: { maxBytes: number; timeoutMs: number; userAgent: string },
  ): Promise<{ status: number; url: string; body: string }>;
}

/** null = the file does not exist; any other failure throws. */
export type RepoReader = (path: string) => Promise<string | null>;

export interface RepoEntry {
  name: string;
  path: string;
  type: string;
  size: number;
}

/** Direct children of `dir` ("" = root); a missing folder lists empty. */
export type FsLister = (dir: string) => Promise<RepoEntry[]>;

/**
 * One call to the BigQuery connection's `bigquery_query` tool, with the
 * tool's own arguments (`projectId`, `query` or `pageToken`, `maxResults`).
 * Resolves to the tool's result; rejects when the tool reports an error.
 */
export type BigQueryRunner = (
  args: Record<string, unknown>,
) => Promise<unknown>;

export type LakeRow = Record<string, string | number | null>;

/** One read-only ClickHouse statement over the org's data lake. */
export type LakeQuery = (sql: string) => Promise<LakeRow[]>;

/** Stores generated media under the org. */
export interface MediaStore {
  /** Writes the object; returns the path `get` and `url` read it back by. */
  put(path: string, bytes: Uint8Array, contentType: string): Promise<string>;
  get(path: string): Promise<Uint8Array | null>;
  /** A short-lived URL a model can fetch the object from. */
  url(path: string): Promise<string>;
}

export type AnalyticsRange = "24h" | "7d" | "30d";

/** The part of the analytics `view=heatmap` payload the diagnosis reads. */
export interface HeatmapPayload {
  registered: boolean;
  siteId: string | null;
  data: {
    hmSummary?: Array<Record<string, number>>;
    hmScroll?: Array<{ depth: number; views: number; reach_pct: number }>;
    hmSections?: Array<{
      root: string;
      seen_views: number;
      reach_pct: number;
      avg_s: number;
      ctr_pct: number;
      clicks: number;
    }>;
    /** One per clicked element. `el` is decimal (UInt64). */
    hmElements?: Array<{
      root: string;
      el: string | number;
      clicks: number | string;
      views?: number | string;
      rage?: number | string;
      dead?: number | string;
      dead_int?: number | string;
    }>;
    /** Per element: who clicked and where they went. `el = 0` is the page. */
    hmFunnel?: Array<{
      root: string;
      el: string;
      visitors: number;
      viewed: number;
      carted: number;
    }>;
    hmPages?: Array<{
      page_key: string;
      device: string;
      views: number;
      clicks: number;
      avg_depth: number;
    }>;
    hmDevices?: Array<{ device: string; views: number; mean_vw: number }>;
    /** Panels whose query failed: empty, not "no data". */
    failedPanels?: string[];
  };
}

export type HeatmapReader = (
  site: string,
  opts: { page: string; device: UxDevice; range: AnalyticsRange },
) => Promise<HeatmapPayload>;
