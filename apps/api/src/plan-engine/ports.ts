/**
 * What the engine needs from the outside world. In the Worker these were
 * Cloudflare bindings and HTTP calls back to Studio; here each one is a port
 * the Studio side implements (the org's AI providers, a sandbox browser, the
 * git providers, object storage, the org's BigQuery connection, analytics).
 */

import type { SourceGap, UxDevice } from "./types.ts";

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
 * is empty or was cut at `maxTokens` (`onUsage` hears every billed call, those
 * included), and with `NoAiModelError` when the org has no model for the tier.
 */
export type Llm = (
  request: LlmRequest,
  onUsage?: (usage: LlmUsage) => void,
) => Promise<string>;

/** Why a run cannot start, or stopped, when the org has no model for it. */
export const NO_AI_MODEL =
  "nenhum modelo de IA conectado: conecte um provedor de IA nas configurações da organização para rodar a análise";

/** The org has no model for the engine: the customer connects a provider. */
export class NoAiModelError extends Error {
  constructor() {
    super(NO_AI_MODEL);
    this.name = "NoAiModelError";
  }
}

/** A missing model ends the run; every other model failure degrades one step. */
export function rethrowNoAiModel(err: unknown): void {
  if (err instanceof NoAiModelError) throw err;
}

/** The gap a run ends with when its model is gone, so Plan asks for a provider. */
export const noAiModelGap = (): SourceGap => ({
  source: "studio",
  error: NO_AI_MODEL,
  owner: "customer",
  key: "ai_provider",
});

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
