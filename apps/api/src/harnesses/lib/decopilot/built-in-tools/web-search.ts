/**
 * web_search built-in tool
 *
 * Server-side tool that performs web research. It drives the supplied
 * `researchJob` async generator, streams each
 * progress event to the UI, and shapes the terminal `ResearchResult` into the
 * tool result. All provider/DB coupling (streaming Perplexity path, durable
 * Gemini Deep Research lifecycle over `async_research_jobs`) lives in the
 * cluster's `researchJob` hook impl (studio-owned; see
 * `createClusterResearchJob` in `cluster-research-job.ts`).
 *
 * Small results stay inline in the tool result; large results are offloaded to
 * blob storage by the hook, which returns a `resultUri` + `preview` instead of
 * the full text.
 */

import { tool, zodSchema, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { ResearchJob } from "../../harness-deps";

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

/** Default description for the quick `web_search` tool. */
const DEFAULT_WEB_SEARCH_DESCRIPTION =
  "Search the web for up-to-date information and synthesize a concise answer. " +
  "Use this for quick lookups, fact-checking, current events, or when the answer " +
  "requires knowledge beyond your training data and a fast response is enough. " +
  "For exhaustive, multi-source reports prefer `deep_research` when available.";

export function createWebSearchTool(
  writer: UIMessageStreamWriter,
  params: {
    /** Cluster-built durable research hook (spec §6). */
    researchJob: ResearchJob;
    toolOutputMap: Map<string, string>;
    /** Current thread/task id — used to scope persisted research jobs. */
    taskId: string;
    /** Overrides the tool description — used by `deep_research`, which shares
     *  this factory but advertises a different intent to the model. */
    description?: string;
  },
) {
  const { researchJob, toolOutputMap, taskId } = params;

  return tool({
    description: params.description ?? DEFAULT_WEB_SEARCH_DESCRIPTION,
    inputSchema: zodSchema(WebSearchInputSchema),
    execute: async (input, options) => {
      const startTime = performance.now();
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

      try {
        const gen = researchJob({
          query: input.query,
          taskId,
          toolCallId: options.toolCallId,
          abortSignal: options.abortSignal,
        });
        let next = await gen.next();
        while (!next.done) {
          writeProgress(next.value.progress);
          next = await gen.next();
        }
        const result = next.value;
        toolOutputMap.set(options.toolCallId, result.text);
        return shapeToolResult({
          query: input.query,
          text: result.text,
          citations: result.citations,
          usage: result.usage,
          resultUri: result.resultUri ?? null,
          preview: result.preview ?? "",
        });
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

function shapeToolResult(args: {
  query: string;
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
      usage: args.usage,
      ...(args.citations.length > 0 && { citations: args.citations }),
    };
  }
  return {
    success: true as const,
    content: args.text,
    query: args.query,
    usage: args.usage,
    ...(args.citations.length > 0 && { citations: args.citations }),
  };
}
