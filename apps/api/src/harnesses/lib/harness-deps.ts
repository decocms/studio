/** Object-storage operations used by Decopilot's media tools. */
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

export interface ResearchParams {
  query: string;
  /** Thread id that scopes the persisted research job. */
  taskId: string;
  /** AI SDK tool-call id used as the durable job's idempotency key. */
  toolCallId: string;
  abortSignal?: AbortSignal;
}

export interface ResearchResult {
  text: string;
  citations: Array<{ url: string; title?: string }>;
  usage: { inputTokens: number; outputTokens: number };
  /** Set when the result was offloaded to object storage. */
  resultUri?: string | null;
  /** Preview returned alongside an offloaded result. */
  preview?: string;
}

export type ResearchJob = (
  params: ResearchParams,
) => AsyncGenerator<{ progress: string }, ResearchResult>;

export interface InterestsWrite {
  orgId: string;
  agentId: string;
  userId: string;
  interests: Array<{ title: string; summary: string }>;
}
