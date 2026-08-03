/**
 * Cluster `researchJob` hook (spec §6).
 *
 * API-OWNED: this closes over `StudioContext` + a `StudioProvider`, so it
 * cannot move into the portable harness. It is the `deps.researchJob`
 * implementation the cluster wires into `HarnessDeps`; the portable
 * `web_search` tool only drives the async generator it returns.
 *
 * Two execution paths, selected per the provider's `asyncResearch` capability:
 *
 *   Async path  — providers with `asyncResearch` (e.g. Gemini Deep Research).
 *                 Submits a job, drives it to terminal state, and persists the
 *                 whole lifecycle to `async_research_jobs`. One row per
 *                 `toolCallId`, so pod death / DBOS step replay can resume the
 *                 same upstream job instead of paying for a duplicate. The row
 *                 is the source of truth for "what happened to this customer's
 *                 research job".
 *
 *   Streaming   — providers without `asyncResearch` (e.g. Perplexity via
 *                 OpenRouter). Calls `streamText` and pipes chunks to the UI.
 *                 State lives entirely on the request; nothing is persisted.
 *
 * Both paths yield `{ progress }` events (the UI write happens in the tool) and
 * return a `ResearchResult`. Large results (> LARGE_RESULT_TOKEN_THRESHOLD
 * output tokens) are offloaded to blob storage and the result carries only a
 * `preview` + `resultUri` (studio-storage://).
 */

import { streamText } from "ai";
import { sleep } from "@decocms/shared/std";
import {
  AsyncResearchTerminalError,
  type StudioProvider,
} from "@/ai-providers/types";
import type { StudioContext } from "@/core/studio-context";
import { sanitizeProviderMetadata } from "@decocms/shared/sdk";
import type { ModelInfo } from "@/harnesses/lib/decopilot/model-info";
import { toStudioStorageUri } from "@/harnesses/lib/decopilot/studio-storage-uri";
import type {
  ResearchParams,
  ResearchResult,
} from "@/harnesses/lib/harness-deps";
import { createOutputPreview } from "@/harnesses/lib/decopilot/built-in-tools/read-tool-output";
import { LARGE_RESULT_TOKEN_THRESHOLD } from "@/harnesses/lib/decopilot/built-in-tools/constants";

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

/**
 * Build the cluster `researchJob` hook over Studio's provider + storage. The
 * returned async generator is the `deps.researchJob` implementation: it yields
 * progress events and returns the final `ResearchResult`.
 */
export function createClusterResearchJob(deps: {
  provider: StudioProvider;
  modelInfo: ModelInfo;
  ctx: StudioContext;
  /**
   * "quick" — always use the streaming path, even if the configured model
   * also supports async research. Wired by the `web_search` tool. This is a
   * defense-in-depth guard: it guarantees a quick lookup never *launches an
   * async research job*, but it does not by itself guarantee low latency (a
   * slow model pinned to the slot would still stream slowly). Keeping slow
   * models out of the `web_search` slot is the UI filter's job
   * (`isQuickSearchModel`); this is the backstop if one slips through.
   * "deep" — auto-select the async path when the provider can handle the
   * model (Gemini Deep Research), else stream. Wired by `deep_research`.
   */
  mode: "quick" | "deep";
  /** Tool name the async path records on its persisted job + stub message. */
  toolName: string;
}) {
  const { provider, modelInfo, ctx, mode, toolName } = deps;
  const modelId = modelInfo.id;

  return async function* researchJob(
    params: ResearchParams,
  ): AsyncGenerator<{ progress: string }, ResearchResult> {
    const asyncResearch = provider.asyncResearch;
    const useAsyncResearch =
      mode === "deep" && asyncResearch?.canHandle(modelId) === true;
    if (useAsyncResearch && asyncResearch) {
      return yield* runAsyncResearch({
        params,
        asyncResearch,
        providerId: provider.info.id,
        modelId,
        toolName,
        ctx,
      });
    }
    return yield* runStreamingResearch({ params, provider, modelId, ctx });
  };
}

// ============================================================================
// Async path — submit / poll / persist via async_research_jobs
// ============================================================================

interface AsyncResearchInvocation {
  params: ResearchParams;
  asyncResearch: NonNullable<StudioProvider["asyncResearch"]>;
  providerId: string;
  modelId: string;
  toolName: string;
  ctx: StudioContext;
}

async function* runAsyncResearch({
  params,
  asyncResearch,
  providerId,
  modelId,
  toolName,
  ctx,
}: AsyncResearchInvocation): AsyncGenerator<
  { progress: string },
  ResearchResult
> {
  const toolCallId = params.toolCallId;
  const taskId = params.taskId;
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
    query: params.query,
  });

  // Terminal-state replay: a previous attempt already completed. Return the
  // cached result rather than re-running. Rare but possible — DBOS only
  // replays unfinished steps, but a duplicate dispatch can still race.
  if (job.status === "completed" && job.resultPreview != null) {
    log("info", "replay-completed", { ...logFields, job: job.id });
    return finalizeCachedResult(job);
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
        query: params.query,
        abortSignal: params.abortSignal,
      });
      interactionId = started.jobId;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await ctx.storage.asyncResearchJobs.markFailed(toolCallId, msg);
      log("error", "submit-failed", { ...logFields, job: job.id, err: msg });
      throw err;
    }
    // Atomically flips the row to 'polling' AND seeds a stub assistant
    // message carrying the tool-input-available part into
    // `thread_message_parts`. The stub is what lets a browser refresh during
    // the long poll window recover gracefully — without it, the eventual
    // `tool-output-available` chunk on reconnect has no matching tool-input in
    // `state.message.parts` and the AI SDK reader throws "No tool invocation
    // found for tool call ID …".
    await ctx.storage.asyncResearchJobs.markPolling(toolCallId, interactionId, {
      threadId: taskId,
      toolName,
      query: params.query,
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
  //    `resume`'s `onProgress` callback can't `yield` (it isn't this
  //    generator), so it pushes transcripts into a queue that this generator
  //    drains and yields between poll ticks.
  let lastSendTime = 0;
  const THROTTLE_MS = 50;
  const progressQueue: string[] = [];

  try {
    let settled = false;
    let resumeError: unknown;
    const resumePromise = asyncResearch
      .resume({
        jobId: job.interactionId!,
        abortSignal: params.abortSignal,
        onProgress: (transcript: string) => {
          const now = Date.now();
          if (now - lastSendTime >= THROTTLE_MS) {
            lastSendTime = now;
            progressQueue.push(transcript);
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
      })
      .catch((err: unknown) => {
        // Stash and rethrow after the drain loop so the catch block below
        // (markFailed / recordPoll) still runs with the real error.
        resumeError = err;
        return undefined;
      })
      .finally(() => {
        settled = true;
      });

    // Drain queued progress between poll ticks. `resume` resolves once the job
    // reaches a terminal state; racing it against a short timeout lets buffered
    // transcripts surface promptly without busy-waiting.
    while (!settled) {
      while (progressQueue.length > 0) {
        yield { progress: progressQueue.shift()! };
      }
      await Promise.race([resumePromise, sleep(THROTTLE_MS)]);
    }
    while (progressQueue.length > 0) {
      yield { progress: progressQueue.shift()! };
    }
    await resumePromise;
    if (resumeError !== undefined) throw resumeError;
    const result = (await resumePromise)!;

    // Final flush — drops the *thinking* prefix streamed during the run.
    yield { progress: result.text };

    // Guard: a "completed" job with empty text is a failure, not a success.
    // Gemini deep-research can finish with only thought_summary blocks (no
    // `type:"text"`), which finalize() collapses to "". Persisting that would
    // write a 0-byte blob and hand the agent a bogus success:true. Throwing
    // here routes through the catch below (markFailed + rethrow), so a retry
    // gets a fresh interaction instead of reusing the empty one. See the
    // empty-text diagnostic in gemini-interactions.ts for the raw block types.
    if (result.text.trim() === "") {
      log("error", "empty-result", {
        ...logFields,
        job: job.id,
        tokens: result.usage.outputTokens,
      });
      throw new AsyncResearchTerminalError(
        "research completed with empty result",
      );
    }

    // 4. Persist result + return the ResearchResult.
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
        resultUri = toStudioStorageUri(key);
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

    return {
      text: result.text,
      citations: result.citations,
      usage: usageMeta,
      resultUri,
      preview: resultUri ? preview : undefined,
    };
  } catch (err) {
    if (params.abortSignal?.aborted) {
      await ctx.storage.asyncResearchJobs.markCancelled(toolCallId, "aborted");
      log("info", "cancelled", { ...logFields, job: job.id });
      throw err;
    }
    const msg = (err as Error).message ?? String(err);
    if (
      err instanceof AsyncResearchTerminalError ||
      (err instanceof Error && err.name === "AsyncResearchTerminalError")
    ) {
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

function finalizeCachedResult(job: {
  resultUri: string | null;
  resultPreview: string | null;
  resultContent: string | null;
  query: string;
}): ResearchResult {
  // Large results live in blob storage — the row carries just preview + uri,
  // and the model fetches the full content via read_resource(uri).
  if (job.resultUri) {
    return {
      text: "",
      citations: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      resultUri: job.resultUri,
      preview: job.resultPreview ?? "",
    };
  }
  // Inline path: `result_content` holds the full text written at completion
  // time. Older completed rows (pre-migration 081) only have the truncated
  // preview — fall back to that so they at least return something.
  const content = job.resultContent ?? job.resultPreview ?? "";
  return {
    text: content,
    citations: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    resultUri: null,
  };
}

// ============================================================================
// Streaming path — unchanged behaviour
// ============================================================================

interface StreamingInvocation {
  params: ResearchParams;
  provider: StudioProvider;
  modelId: string;
  ctx: StudioContext;
}

async function* runStreamingResearch({
  params,
  provider,
  modelId,
  ctx,
}: StreamingInvocation): AsyncGenerator<{ progress: string }, ResearchResult> {
  const model = provider.aiSdk.languageModel(modelId);
  const result = streamText({
    model,
    prompt: params.query,
    abortSignal: params.abortSignal,
  });

  let fullText = "";
  let lastSendTime = 0;
  const THROTTLE_MS = 50;

  for await (const chunk of result.textStream) {
    fullText += chunk;
    const now = Date.now();
    if (now - lastSendTime >= THROTTLE_MS) {
      lastSendTime = now;
      yield { progress: fullText };
    }
  }
  yield { progress: fullText };

  const [usage, sources, providerMetadata] = await Promise.all([
    result.usage,
    result.sources,
    result.providerMetadata,
  ]);
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  // Sanitize provider metadata even though we no longer thread it through the
  // ResearchResult — the call has telemetry/side-effect parity with before.
  sanitizeProviderMetadata(
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

  const usageMeta = { inputTokens, outputTokens };

  if (outputTokens > LARGE_RESULT_TOKEN_THRESHOLD && ctx.objectStorage) {
    const key = `web-search/${crypto.randomUUID()}.md`;
    const bytes = new TextEncoder().encode(fullText);
    try {
      await ctx.objectStorage.put(key, bytes, {
        contentType: "text/markdown",
      });
      return {
        text: fullText,
        citations,
        usage: usageMeta,
        resultUri: toStudioStorageUri(key),
        preview: createOutputPreview(fullText),
      };
    } catch (err) {
      console.error(
        "[web-search] Failed to upload to storage, returning inline",
        err,
      );
    }
  }

  return { text: fullText, citations, usage: usageMeta, resultUri: null };
}
