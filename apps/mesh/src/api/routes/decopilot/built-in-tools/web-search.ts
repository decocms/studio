/**
 * web_search Built-in Tool
 *
 * Server-side tool that performs web research using deep research models
 * (e.g. Perplexity Sonar) through OpenRouter. Calls streamText with the
 * provider's languageModel — OpenRouter handles the routing to the
 * underlying research model.
 *
 * Text chunks are streamed to the UI via data parts so the user sees
 * the research in real time.
 *
 * Small results are returned inline in the tool result (stays in thread).
 * Large results (> 8k output tokens) are stored in blob storage and the
 * tool result contains only a preview + mesh-storage: URI. The model can
 * re-access the full content in later turns via read_resource(uri).
 */

import { tool, zodSchema, streamText, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import {
  AsyncResearchTerminalError,
  type MeshProvider,
} from "@/ai-providers/types";
import type { MeshContext } from "@/core/mesh-context";
import { sanitizeProviderMetadata } from "@decocms/mesh-sdk";
import type { ModelInfo } from "../types";
import { createOutputPreview } from "./read-tool-output";
import { toMeshStorageUri } from "../mesh-storage-uri";
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

export function createWebSearchTool(
  writer: UIMessageStreamWriter,
  params: {
    provider: MeshProvider;
    deepResearchModelInfo: ModelInfo;
    ctx: MeshContext;
    toolOutputMap: Map<string, string>;
    /** Current thread/task id — used to find or persist Gemini interactions. */
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
      try {
        const modelId = deepResearchModelInfo.id;
        const asyncResearch = provider.asyncResearch;
        const useAsyncResearch = asyncResearch?.canHandle(modelId) === true;

        let fullText = "";
        let citations: Array<{ url: string; title?: string }> = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let safeProviderMeta:
          | ReturnType<typeof sanitizeProviderMetadata>
          | undefined;

        const writeProgress = (text: string) => {
          (writer as any).write({
            type: "data-web-search",
            id: options.toolCallId,
            data: { text },
          });
        };

        if (useAsyncResearch && asyncResearch) {
          const providerId = provider.info.id;

          // Resume path: if a previous run for this (thread, provider, model,
          // query) already submitted a job and never reached terminal state,
          // resume that one instead of paying for a fresh job.
          const existing = await ctx.storage.threads.findInflightAsyncJob(
            taskId,
            providerId,
            modelId,
            input.query,
          );
          let jobId: string;
          if (existing) {
            jobId = existing.jobId;
          } else {
            const started = await asyncResearch.start({
              modelId,
              query: input.query,
              abortSignal: options.abortSignal,
            });
            jobId = started.jobId;
            // Persist BEFORE polling — if the pod dies during the wait, the
            // next pod that retries this tool call will find this row.
            await ctx.storage.threads.addInflightAsyncJob(taskId, {
              toolCallId: options.toolCallId,
              provider: providerId,
              modelId,
              query: input.query,
              jobId,
              startedAt: new Date().toISOString(),
            });
          }

          let lastSendTime = 0;
          const THROTTLE_MS = 50;

          // Only delete the persisted handle when we know the provider-side
          // job is gone (success OR terminal provider failure). Transient
          // errors (network, 5xx) keep the row so the next attempt can
          // reconnect to the still-running job rather than spawning a fresh
          // expensive duplicate.
          let providerJobGone = false;
          try {
            const result = await asyncResearch.resume({
              jobId,
              abortSignal: options.abortSignal,
              onProgress: (transcript: string) => {
                const now = Date.now();
                if (now - lastSendTime >= THROTTLE_MS) {
                  lastSendTime = now;
                  writeProgress(transcript);
                }
              },
            });
            providerJobGone = true;
            fullText = result.text;
            citations = result.citations;
            inputTokens = result.usage.inputTokens;
            outputTokens = result.usage.outputTokens;
            // Final flush with the report only — drops the *thinking* prefix
            // streamed during the run.
            writeProgress(fullText);
          } catch (err) {
            if (err instanceof AsyncResearchTerminalError) {
              providerJobGone = true;
            }
            throw err;
          } finally {
            if (providerJobGone) {
              await ctx.storage.threads.removeInflightAsyncJob(
                taskId,
                providerId,
                modelId,
                input.query,
              );
            }
          }
        } else {
          const model = provider.aiSdk.languageModel(deepResearchModelInfo.id);

          const result = streamText({
            model,
            prompt: input.query,
            abortSignal: options.abortSignal,
          });

          // Accumulate text while streaming to the UI.
          // The AI SDK replaces data parts with the same id on each write,
          // so we send the full accumulated text (not just the delta).
          // Throttled to limit wire overhead.
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
          // Final flush to ensure all text is sent
          writeProgress(fullText);

          const [usage, sources, providerMetadata] = await Promise.all([
            result.usage,
            result.sources,
            result.providerMetadata,
          ]);
          inputTokens = usage.inputTokens ?? 0;
          outputTokens = usage.outputTokens ?? 0;
          safeProviderMeta = sanitizeProviderMetadata(
            providerMetadata as Record<string, unknown> | undefined,
          );

          // Normalize sources into a simple { url, title } array for the UI.
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
                    "title" in s && typeof s.title === "string"
                      ? s.title
                      : undefined,
                });
              }
            }
          }
        }

        // Always store in toolOutputMap for read_tool_output within this loop.
        toolOutputMap.set(options.toolCallId, fullText);

        const usageMeta = {
          inputTokens,
          outputTokens,
          providerMetadata: safeProviderMeta,
        };

        // Large results → blob storage, compact tool result with URI.
        // The model can re-access it later via read_resource("mesh-storage://…").
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
              model: deepResearchModelInfo.id,
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

        // Small result — return content inline so it stays in thread history.
        return {
          success: true as const,
          content: fullText,
          query: input.query,
          model: deepResearchModelInfo.id,
          usage: usageMeta,
          ...(citations.length > 0 && { citations }),
        };
      } finally {
        const latencyMs = performance.now() - startTime;
        writer.write({
          type: "data-tool-metadata",
          id: options.toolCallId,
          data: { latencyMs },
        });
      }
    },
  });
}
