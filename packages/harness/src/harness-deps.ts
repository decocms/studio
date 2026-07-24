/**
 * HarnessDeps — the unified decopilot harness's injected dependency bag
 * (spec 2026-06-11-harness-extraction-design.md §5.1).
 *
 * Capability gating = hook ABSENCE (the dependent tool is simply not built).
 * `modelProvider` is intentionally NOT a hook: it is derived inside the harness
 * from HarnessStreamInput model sources. The supporting payload shapes are
 * intentionally MINIMAL — only the HOOK SURFACE is pinned here.
 */

export interface EditOp {
  oldText: string;
  newText: string;
}
export interface BashOpts {
  cwd?: string;
  timeoutMs?: number;
}
export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export interface GrepOpts {
  glob?: string;
  caseInsensitive?: boolean;
}
export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Object-storage hook surface (spec §14). Structurally a subset of the
 * cluster's `BoundObjectStorage`, so `ctx.objectStorage` is assignable
 * directly. Kept as a standalone interface (no `@/` import) so this file
 * stays portable when it moves to `@decocms/harness`.
 */
export interface ObjectStorageHooks {
  getBytesOrPresign(
    key: string,
    opts: { presignWhenLargerThan: number; presignExpiresIn?: number },
  ): Promise<
    | { content: string; contentType: string; encoding: string; size: number }
    | { error: string; size: number; presignedUrl: string; contentType: string }
  >;
  getBytes(key: string): Promise<Uint8Array>;
  put(
    key: string,
    body: string | Uint8Array,
    options?: { contentType?: string },
  ): Promise<unknown>;
  head(key: string): Promise<{ contentType: string; size: number }>;
  presignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  presignedPutUrl(
    key: string,
    expiresIn?: number,
    contentType?: string,
  ): Promise<string>;
}

/**
 * Portable MCP-client view returned by `mcpForAgent`. Generalizes the
 * cluster's in-process `createVirtualClientFrom(...)` + `PassthroughClient`
 * seam so the daemon/desktop can swap in an HTTP `Client` at the agent's
 * `mcp.url`. Only the surface the harness tool-assembler actually drives is
 * pinned — `getInstructions` + `getConnectionTitleMap` are the
 * PassthroughClient extras the cluster relies on for the prompt/connections
 * blocks. Structurally a subset of `@modelcontextprotocol/sdk` `Client`, so a
 * concrete `PassthroughClient` / `Client` is assignable directly (no `@/` or
 * SDK import here keeps this file portable to `@decocms/harness`).
 */
export interface McpClient {
  listTools(): Promise<{
    tools: Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean };
      _meta?: { gatewayClientId?: string };
      [k: string]: unknown;
    }>;
  }>;
  callTool(params: { name: string; arguments?: unknown }): Promise<unknown>;
  listResources(): Promise<{ resources: unknown[] }>;
  readResource(params: { uri: string }): Promise<{ contents: unknown[] }>;
  listPrompts(): Promise<{ prompts: unknown[] }>;
  getPrompt(params: { name: string }): Promise<{ messages: unknown[] }>;
  getInstructions(): string | undefined;
  getConnectionTitleMap(): Map<string, string>;
  close(): Promise<void>;
}

/**
 * Durable web-research hook payload (spec §6). The cluster's `researchJob`
 * closure owns the provider call + `async_research_jobs` lifecycle; the
 * portable `web_search` tool only drives the generator with these params.
 */
export interface ResearchParams {
  query: string;
  /** Thread (task) id — scopes the persisted research job row. */
  taskId: string;
  /** AI SDK tool call id — the idempotency key for the durable job row. */
  toolCallId: string;
  abortSignal?: AbortSignal;
}
export interface ResearchResult {
  text: string;
  citations: Array<{ url: string; title?: string }>;
  usage: { inputTokens: number; outputTokens: number };
  /** Set when the durable hook already offloaded the result to blob storage. */
  resultUri?: string | null;
  /** Preview snippet returned alongside `resultUri` for offloaded results. */
  preview?: string;
}
export interface InterestsWrite {
  orgId: string;
  agentId: string;
  userId: string;
  interests: Array<{ title: string; summary: string }>;
}
export interface LlmCall {
  [k: string]: unknown;
}
export interface LlmMonitor {
  [k: string]: unknown;
}

export interface HarnessDeps {
  onRead(path: string): Promise<string>;
  onWrite(path: string, content: string): Promise<void>;
  onEdit(path: string, edits: EditOp[]): Promise<void>;
  onBash(cmd: string, opts?: BashOpts): Promise<BashResult>;
  onGlob(pattern: string): Promise<string[]>;
  onGrep(pattern: string, opts?: GrepOpts): Promise<GrepHit[]>;

  objectStorage: ObjectStorageHooks;

  /**
   * Whether external image URLs may be fetched over plain HTTP (in addition
   * to HTTPS). Cluster sets this from `getSettings().localMode`; desktop sets
   * it from its local-mode flag. Universal (never undefined) so the consuming
   * tools don't reach for settings themselves.
   */
  allowHttpExternalUrls: boolean;

  mcpForAgent(
    agentId: string,
    opts?: { superUser?: boolean; listTimeoutMs?: number },
  ): Promise<McpClient>;

  browserless?: { baseUrl: string; token: string };

  researchJob?(
    params: ResearchParams,
  ): AsyncGenerator<{ progress: string }, ResearchResult>;
  interests?: { write(input: InterestsWrite): Promise<void> };
  telemetry?: {
    recordLlmCall(p: LlmCall): void;
    monitorLlmCall(p: LlmMonitor): void;
  };
}
