/**
 * web_search Built-in Tool
 *
 * Server-side tool that performs web research using deep research models
 * (e.g. Perplexity Sonar, Gemini Deep Research).
 *
 * Two execution paths:
 *
 *   Streaming path  — providers without `asyncResearch` (e.g. Perplexity via
 *                     OpenRouter). Calls `streamText` and pipes chunks to the
 *                     UI. State lives entirely on the request; nothing is
 *                     persisted.
 *
 *   Async path      — providers with `asyncResearch` (e.g. Gemini Deep
 *                     Research). Submits a job, drives it to terminal state,
 *                     and persists the whole lifecycle to
 *                     `async_research_jobs`. One row per `toolCallId`, so
 *                     pod death / DBOS step replay can resume the same
 *                     upstream job instead of paying for a duplicate.
 *
 * The async path is the source of truth for "what happened to this
 * customer's research job" — the row records status, attempts, last error,
 * tokens, result preview. Debugging is one SQL query against thread_id.
 *
 * Small results stay inline in the tool result (kept in thread history).
 * Large results (> 8k output tokens) move to blob storage and the tool
 * result carries only a preview + mesh-storage:// URI.
 */

import { tool, zodSchema, streamText, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import {
  AsyncResearchTerminalError,
  type MeshProvider,
} from "@/ai-providers/types";
import type { MeshContext } from "@/core/mesh-context";
import { sanitizeProviderMetadata } from "@decocms/mesh-sdk";
import type { ModelInfo } from "../../../api/routes/decopilot/types";
import { createOutputPreview } from "./read-tool-output";
import { toMeshStorageUri } from "../../../api/routes/decopilot/mesh-storage-uri";
import { LARGE_RESULT_TOKEN_THRESHOLD } from "./constants";

const WebSearchInputSchema = z.object({
  query: z
    .string()
    .max(10_000)
    .describe(
      "The research query. Be specific about what information you need. " +
        "The research model will search the web and synthesize a comprehensive answer.",
    ),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

/**
 * Single grep-friendly log prefix for the async path. Combined with
 * `tool_call_id` / `interaction_id`, one filter pulls the whole lifecycle:
 *
 *     grep '[web-search]' | grep tc=<id>
 */
function log(
  level: "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown>,
) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  const line = `[web-search] ${msg} ${parts}`.trim();
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createWebSearchTool(
  writer: UIMessageStreamWriter,
  params: {
    provider: MeshProvider;
    deepResearchModelInfo: ModelInfo;
    ctx: MeshContext;
    toolOutputMap: Map<string, string>;
    /** Current thread/task id — used to scope persisted research jobs. */
    taskId: string;
  },
) {
  const { provider, deepResearchModelInfo, ctx, toolOutputMap, taskId } =
    params;

  return tool({
    description:
      "Search the web and synthesize a comprehensive research report. " +
      "Use this when the user needs up-to-date information from the internet, " +
      "in-depth research on a topic, fact-checking, or when the answer requires " +
      "knowledge beyond your training data.",
    inputSchema: zodSchema(WebSearchInputSchema),
    execute: async (input, options) => {
      const startTime = performance.now();
      const modelId = deepResearchModelInfo.id;
      const asyncResearch = provider.asyncResearch;
      const useAsyncResearch = asyncResearch?.canHandle(modelId) === true;

      const writeProgress = (text: string) => {
        (
          writer as unknown as {
            write: (part: {
              type: string;
              id: string;
              data: { text: string };
            }) => void;
          }
        ).write({
          type: "data-web-search",
          id: options.toolCallId,
          data: { text },
        });
      };

      const emitToolMetadata = () => {
        const latencyMs = performance.now() - startTime;
        writer.write({
          type: "data-tool-metadata",
          id: options.toolCallId,
          data: { latencyMs },
        });
      };

      try {
        if (useAsyncResearch && asyncResearch) {
          return await runAsyncResearch({
            input,
            options,
            asyncResearch,
            providerId: provider.info.id,
            modelId,
            ctx,
            taskId,
            toolOutputMap,
            writeProgress,
          });
        }
        return await runStreamingResearch({
          input,
          options,
          provider,
          modelId,
          toolOutputMap,
          ctx,
          writeProgress,
        });
      } finally {
        emitToolMetadata();
      }
    },
  });
}

// ============================================================================
// Async path — submit / poll / persist via async_research_jobs
// ============================================================================

interface AsyncResearchInvocation {
  input: WebSearchInput;
  options: { toolCallId: string; abortSignal?: AbortSignal };
  asyncResearch: NonNullable<MeshProvider["asyncResearch"]>;
  providerId: string;
  modelId: string;
  ctx: MeshContext;
  taskId: string;
  toolOutputMap: Map<string, string>;
  writeProgress: (text: string) => void;
}

async function runAsyncResearch({
  input,
  options,
  asyncResearch,
  providerId,
  modelId,
  ctx,
  taskId,
  toolOutputMap,
  writeProgress,
}: AsyncResearchInvocation) {
  const toolCallId = options.toolCallId;
  const logFields = {
    tc: toolCallId,
    thread: taskId,
    provider: providerId,
    model: modelId,
  };

  // 1. Idempotent insert. If a row already exists for this tool call (DBOS
  //    replay, pod handoff), we get it back instead of inserting again. The
  //    UNIQUE(organization_id, tool_call_id) constraint makes this safe.
  let job = await ctx.storage.asyncResearchJobs.upsertPending({
    threadId: taskId,
    toolCallId,
    provider: providerId,
    modelId,
    query: input.query,
  });

  // Terminal-state replay: a previous attempt already completed. Return the
  // cached result rather than re-running. Rare but possible — DBOS only
  // replays unfinished steps, but a duplicate dispatch can still race.
  if (job.status === "completed" && job.resultPreview != null) {
    log("info", "replay-completed", { ...logFields, job: job.id });
    return finalizeCachedResult(job, input, toolOutputMap, modelId, toolCallId);
  }
  if (job.status === "failed" || job.status === "cancelled") {
    log("warn", `replay-${job.status}`, {
      ...logFields,
      job: job.id,
      err: job.lastError,
    });
    throw new Error(job.lastError ?? `previous research ${job.status}`);
  }

  // 2. Submit if needed. `interactionId` is null until the provider has
  //    accepted the job; once set, this is a resume path.
  if (!job.interactionId) {
    log("info", "submit", { ...logFields, job: job.id });
    let interactionId: string;
    try {
      const started = await asyncResearch.start({
        modelId,
        query: input.query,
        abortSignal: options.abortSignal,
      });
      interactionId = started.jobId;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await ctx.storage.asyncResearchJobs.markFailed(toolCallId, msg);
      log("error", "submit-failed", { ...logFields, job: job.id, err: msg });
      throw err;
    }
    // Atomically flips the row to 'polling' AND writes a stub
    // assistant message carrying the tool-input-available part. The
    // stub is what lets a browser refresh during the long poll window
    // recover gracefully — without it, the eventual
    // `tool-output-available` chunk on reconnect has no matching
    // tool-input in `state.message.parts` and the AI SDK reader
    // throws "No tool invocation found for tool call ID …".
    await ctx.storage.asyncResearchJobs.markPolling(toolCallId, interactionId, {
      threadId: taskId,
      toolName: "web_search",
      query: input.query,
    });
    job = { ...job, interactionId, status: "polling" };
    log("info", "polling-started", {
      ...logFields,
      job: job.id,
      interaction: interactionId,
    });
  } else {
    log("info", "polling-resumed", {
      ...logFields,
      job: job.id,
      interaction: job.interactionId,
      attempts: job.attempts,
    });
  }

  // 3. Drive to terminal state. The provider's `resume` polls under the
  //    hood; the row's `attempts` is bumped on each tick via `recordPoll`.
  let lastSendTime = 0;
  const THROTTLE_MS = 50;

  try {
    const result = await asyncResearch.resume({
      jobId: job.interactionId!,
      abortSignal: options.abortSignal,
      onProgress: (transcript: string) => {
        const now = Date.now();
        if (now - lastSendTime >= THROTTLE_MS) {
          lastSendTime = now;
          writeProgress(transcript);
        }
        // Fire-and-forget; the UPDATE is small and ordering with the next
        // poll tick doesn't matter for correctness.
        void ctx.storage.asyncResearchJobs
          .recordPoll(toolCallId)
          .catch((err) => {
            log("warn", "record-poll-failed", {
              ...logFields,
              job: job.id,
              err: (err as Error).message,
            });
          });
      },
    });

    // Final flush — drops the *thinking* prefix streamed during the run.
    writeProgress(result.text);

    // 4. Persist result + return tool-shaped response.
    const usageMeta = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
    const useBlobStorage =
      result.usage.outputTokens > LARGE_RESULT_TOKEN_THRESHOLD &&
      ctx.objectStorage != null;
    let resultUri: string | null = null;
    if (useBlobStorage && ctx.objectStorage) {
      const key = `web-search/${crypto.randomUUID()}.md`;
      try {
        await ctx.objectStorage.put(
          key,
          new TextEncoder().encode(result.text),
          { contentType: "text/markdown" },
        );
        resultUri = toMeshStorageUri(key);
      } catch (err) {
        log("warn", "blob-upload-failed", {
          ...logFields,
          job: job.id,
          err: (err as Error).message,
        });
      }
    }

    const preview = createOutputPreview(result.text);
    await ctx.storage.asyncResearchJobs.markCompleted(toolCallId, {
      inputTokens: usageMeta.inputTokens,
      outputTokens: usageMeta.outputTokens,
      citations: result.citations,
      resultUri,
      resultPreview: preview,
      // Full text for inline results so a later replay of the same
      // tool_call_id returns the original report instead of the
      // truncated preview. NULL when offloaded to blob storage —
      // the URI is the source of truth in that case.
      resultContent: resultUri ? null : result.text,
    });
    log("info", "completed", {
      ...logFields,
      job: job.id,
      tokens: usageMeta.outputTokens,
      citations: result.citations.length,
      uri: resultUri ?? "inline",
    });

    toolOutputMap.set(toolCallId, result.text);
    return shapeToolResult({
      query: input.query,
      modelId,
      text: result.text,
      citations: result.citations,
      usage: usageMeta,
      resultUri,
      preview,
    });
  } catch (err) {
    if (options.abortSignal?.aborted) {
      await ctx.storage.asyncResearchJobs.markCancelled(toolCallId, "aborted");
      log("info", "cancelled", { ...logFields, job: job.id });
      throw err;
    }
    const msg = (err as Error).message ?? String(err);
    if (err instanceof AsyncResearchTerminalError) {
      // Provider says the job is dead. Mark failed so a retry won't reuse
      // the same interaction id.
      await ctx.storage.asyncResearchJobs.markFailed(toolCallId, msg);
      log("error", "terminal-failure", { ...logFields, job: job.id, err: msg });
      throw err;
    }
    // Transient: record the error on the row but leave status='polling' so
    // a retry can resume against the same interaction. The sweeper marks
    // the row abandoned if nothing ever does.
    await ctx.storage.asyncResearchJobs
      .recordPoll(toolCallId, msg)
      .catch(() => {});
    log("warn", "transient-error", { ...logFields, job: job.id, err: msg });
    throw err;
  }
}

function finalizeCachedResult(
  job: {
    resultUri: string | null;
    resultPreview: string | null;
    resultContent: string | null;
    query: string;
  },
  input: WebSearchInput,
  toolOutputMap: Map<string, string>,
  modelId: string,
  toolCallId: string,
) {
  // Large results live in blob storage — the row carries just preview +
  // uri, and the model fetches the full content via read_resource(uri).
  if (job.resultUri) {
    return {
      success: true as const,
      uri: job.resultUri,
      preview: job.resultPreview ?? "",
      query: input.query,
      model: modelId,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  // Inline path: `result_content` holds the full text written at
  // completion time. Older completed rows (pre-migration 081) only
  // have the truncated preview — fall back to that so they at least
  // return something rather than an empty string.
  const content = job.resultContent ?? job.resultPreview ?? "";
  // read_tool_output is keyed by toolCallId everywhere; using
  // input.query here was a copy-paste bug that broke the model's
  // re-grep flow on replayed runs.
  toolOutputMap.set(toolCallId, content);
  return {
    success: true as const,
    content,
    query: input.query,
    model: modelId,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function shapeToolResult(args: {
  query: string;
  modelId: string;
  text: string;
  citations: Array<{ url: string; title?: string }>;
  usage: { inputTokens: number; outputTokens: number };
  resultUri: string | null;
  preview: string;
}) {
  if (args.resultUri) {
    return {
      success: true as const,
      uri: args.resultUri,
      preview: args.preview,
      query: args.query,
      model: args.modelId,
      usage: args.usage,
      ...(args.citations.length > 0 && { citations: args.citations }),
    };
  }
  return {
    success: true as const,
    content: args.text,
    query: args.query,
    model: args.modelId,
    usage: args.usage,
    ...(args.citations.length > 0 && { citations: args.citations }),
  };
}

// ============================================================================
// Streaming path — unchanged behaviour, refactored for symmetry
// ============================================================================

interface StreamingInvocation {
  input: WebSearchInput;
  options: { toolCallId: string; abortSignal?: AbortSignal };
  provider: MeshProvider;
  modelId: string;
  toolOutputMap: Map<string, string>;
  ctx: MeshContext;
  writeProgress: (text: string) => void;
}

async function runStreamingResearch({
  input,
  options,
  provider,
  modelId,
  toolOutputMap,
  ctx,
  writeProgress,
}: StreamingInvocation) {
  const model = provider.aiSdk.languageModel(modelId);
  const result = streamText({
    model,
    prompt: input.query,
    abortSignal: options.abortSignal,
  });

  let fullText = "";
  let lastSendTime = 0;
  const THROTTLE_MS = 50;

  for await (const chunk of result.textStream) {
    fullText += chunk;
    const now = Date.now();
    if (now - lastSendTime >= THROTTLE_MS) {
      lastSendTime = now;
      writeProgress(fullText);
    }
  }
  writeProgress(fullText);

  const [usage, sources, providerMetadata] = await Promise.all([
    result.usage,
    result.sources,
    result.providerMetadata,
  ]);
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const safeProviderMeta = sanitizeProviderMetadata(
    providerMetadata as Record<string, unknown> | undefined,
  );

  const citations: Array<{ url: string; title?: string }> = [];
  if (sources && Array.isArray(sources)) {
    for (const s of sources) {
      if (
        s &&
        typeof s === "object" &&
        "sourceType" in s &&
        s.sourceType === "url" &&
        "url" in s &&
        typeof s.url === "string"
      ) {
        citations.push({
          url: s.url,
          title:
            "title" in s && typeof s.title === "string" ? s.title : undefined,
        });
      }
    }
  }

  toolOutputMap.set(options.toolCallId, fullText);

  const usageMeta = {
    inputTokens,
    outputTokens,
    providerMetadata: safeProviderMeta,
  };

  if (outputTokens > LARGE_RESULT_TOKEN_THRESHOLD && ctx.objectStorage) {
    const key = `web-search/${crypto.randomUUID()}.md`;
    const bytes = new TextEncoder().encode(fullText);
    try {
      await ctx.objectStorage.put(key, bytes, {
        contentType: "text/markdown",
      });
      const preview = createOutputPreview(fullText);
      return {
        success: true as const,
        uri: toMeshStorageUri(key),
        preview,
        query: input.query,
        model: modelId,
        usage: usageMeta,
        ...(citations.length > 0 && { citations }),
      };
    } catch (err) {
      console.error(
        "[web-search] Failed to upload to storage, returning inline",
        err,
      );
    }
  }

  return {
    success: true as const,
    content: fullText,
    query: input.query,
    model: modelId,
    usage: usageMeta,
    ...(citations.length > 0 && { citations }),
  };
}
