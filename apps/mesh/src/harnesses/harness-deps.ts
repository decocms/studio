/**
 * HarnessDeps — the unified decopilot harness's injected dependency bag
 * (spec 2026-06-11-harness-extraction-design.md §5.1).
 *
 * Capability gating = hook ABSENCE (the dependent tool is simply not built).
 * `modelProvider` is intentionally NOT a hook: it is derived inside the harness
 * from HarnessStreamInput model sources. Lives under apps/mesh/src/harnesses/
 * for now (step 1a); moves to @decocms/harness in step 3. The supporting payload
 * shapes are intentionally MINIMAL — only the HOOK SURFACE is pinned here.
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

export interface McpClient {
  getInstructions?(): Promise<string | undefined> | string | undefined;
  [k: string]: unknown;
}

export interface ResearchParams {
  query: string;
  [k: string]: unknown;
}
export interface ResearchResult {
  [k: string]: unknown;
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
