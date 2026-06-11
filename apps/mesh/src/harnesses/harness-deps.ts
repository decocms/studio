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

export interface ObjectStorageHooks {
  put(key: string, body: Uint8Array | string): Promise<{ key: string }>;
  presignGet(key: string): Promise<string>;
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
  agentId: string;
  content: string;
  [k: string]: unknown;
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
