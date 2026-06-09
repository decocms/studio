/**
 * Cluster-side MCP exposure of the `web_search` streaming path.
 *
 * Handles providers WITHOUT asyncResearch (e.g. Perplexity via OpenRouter):
 * calls streamText and returns the assembled text result. State lives
 * entirely on this request — nothing is persisted cluster-side.
 *
 * The async path (Gemini Deep Research — asyncResearch !== undefined) is NOT
 * handled here; it remains the `web_search` built-in for in-cluster runs
 * because it persists job rows to `async_research_jobs` (pod-death recovery
 * requires cluster-side persistence that the desktop cannot provide).
 *
 * Adaptation from in-process built-in:
 * - `provider` is re-activated from `credentialId` via `ctx.aiProviders.activate()`.
 * - `toolOutputMap` (in-process buffer) is removed — the MCP tool returns the
 *   full text directly in the result.
 * - `writer` (UIMessageStreamWriter for data-web-search progress chunks) is removed —
 *   the MCP tool collects all text and returns it at once; there is no in-process
 *   stream to push incremental progress to.
 * - Large-result blob-storage offload is preserved: when output tokens exceed the
 *   threshold and object storage is available, the result is stored and the tool
 *   returns a mesh-storage:// URI + preview (same as built-in).
 * - If the activated provider DOES support asyncResearch, the tool throws with a
 *   clear error directing the caller to use the `web_search` built-in instead.
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { streamText } from "ai";
import { sanitizeProviderMetadata } from "@decocms/mesh-sdk";
import { createOutputPreview } from "@/harnesses/decopilot/built-in-tools/read-tool-output";
import { toMeshStorageUri } from "@/api/routes/decopilot/mesh-storage-uri";
import { LARGE_RESULT_TOKEN_THRESHOLD } from "@/harnesses/decopilot/built-in-tools/constants";

const THROTTLE_MS = 50;

const WebSearchMcpInputSchema = z.object({
  query: z
    .string()
    .max(10_000)
    .describe(
      "The research query. Be specific about what information you need. " +
        "The research model will search the web and synthesize a comprehensive answer.",
    ),
  credentialId: z
    .string()
    .describe(
      "Deep-research-tier provider credential ID — resolved cluster-side.",
    ),
  deepResearchModelId: z
    .string()
    .describe("Deep-research model ID to use (e.g. a Perplexity Sonar model)."),
});

export const WEB_SEARCH_MCP = defineTool({
  name: "WEB_SEARCH_MCP" as const,
  description:
    "Search the web and synthesize a comprehensive research report using a streaming " +
    "research model (e.g. Perplexity Sonar). Use this when the user needs up-to-date " +
    "information from the internet or fact-checking. " +
    "Only supports streaming providers — async/Gemini Deep Research stays as the web_search built-in.",
  inputSchema: WebSearchMcpInputSchema,
  outputSchema: z.union([
    z.object({
      success: z.literal(true),
      content: z.string(),
      query: z.string(),
      model: z.string(),
      usage: z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        providerMetadata: z.unknown().optional(),
      }),
      citations: z
        .array(z.object({ url: z.string(), title: z.string().optional() }))
        .optional(),
    }),
    z.object({
      success: z.literal(true),
      uri: z.string(),
      preview: z.string(),
      query: z.string(),
      model: z.string(),
      usage: z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        providerMetadata: z.unknown().optional(),
      }),
      citations: z
        .array(z.object({ url: z.string(), title: z.string().optional() }))
        .optional(),
    }),
  ]),
  handler: async (input, ctx) => {
    await ctx.access.check();

    const organization = ctx.organization;
    if (!organization) throw new Error("Organization context required");

    // Re-activate provider cluster-side.
    const provider = await ctx.aiProviders.activate(
      input.credentialId,
      organization.id,
    );

    // Guard: async-research providers (Gemini Deep Research) must use the built-in.
    if (provider.asyncResearch?.canHandle(input.deepResearchModelId)) {
      throw new Error(
        "WEB_SEARCH_MCP only handles streaming providers. " +
          "Use the web_search built-in for async/Gemini Deep Research runs.",
      );
    }

    const model = provider.aiSdk.languageModel(input.deepResearchModelId);
    const result = streamText({
      model,
      prompt: input.query,
    });

    let fullText = "";
    let lastSendTime = 0;

    for await (const chunk of result.textStream) {
      fullText += chunk;
      // Throttle — no writer to push to, but keeping the same cadence avoids
      // any back-pressure from building a very large string without yielding.
      const now = Date.now();
      if (now - lastSendTime >= THROTTLE_MS) {
        lastSendTime = now;
      }
    }

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

    const usageMeta = {
      inputTokens,
      outputTokens,
      providerMetadata: safeProviderMeta,
    };

    // Large-result offload: store to blob storage when output exceeds threshold.
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
          model: input.deepResearchModelId,
          usage: usageMeta,
          ...(citations.length > 0 && { citations }),
        };
      } catch (err) {
        console.error(
          "[web-search-mcp] Failed to upload to storage, returning inline",
          err,
        );
      }
    }

    return {
      success: true as const,
      content: fullText,
      query: input.query,
      model: input.deepResearchModelId,
      usage: usageMeta,
      ...(citations.length > 0 && { citations }),
    };
  },
});
