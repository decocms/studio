/**
 * What the engine needs from the outside world. In the Worker these were
 * Cloudflare bindings and HTTP calls back to Studio; here each one is a port
 * the Studio side implements (the org's AI providers, a sandbox browser, the
 * git providers, object storage, the org's BigQuery connection, analytics).
 */

import type { UxDevice } from "./types.ts";

/** Token counts the provider billed for one call. */
export interface LlmUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface LlmRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  imageUrls?: string[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  timeoutMs?: number;
}

/** One chat completion; resolves to the model's text. */
export type Llm = (
  request: LlmRequest,
  onUsage?: (usage: LlmUsage) => void,
) => Promise<string>;

/** A page opened at a device's viewport. */
export interface BrowserPage {
  url(): string;
  evaluate<T>(fn: () => T): Promise<T>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface BrowserPort {
  openPage(url: string, device: UxDevice): Promise<BrowserPage>;
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

export interface BigQueryResult {
  rows: Array<Record<string, unknown>>;
  bytesBilled: number | null;
}

export type BigQueryRunner = (
  query: string,
  ctx: { label: string },
) => Promise<BigQueryResult>;

/** Stores generated media under the org and names it for the tools' output. */
export interface MediaStore {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<string>;
  get(path: string): Promise<Uint8Array | null>;
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
