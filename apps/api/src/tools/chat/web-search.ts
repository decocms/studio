/**
 * web_search / deep_research — the Decopilot built-ins' research job, over the
 * org's `web_search` / `deep_research` tiers.
 *
 * Deep research runs for minutes. Each step of the job (a streamed chunk, an
 * async-research poll) is forwarded as an MCP progress notification, which is
 * what resets Claude Code's per-call idle watchdog; and the call is bounded on
 * the job going quiet, never on how long it has run.
 */

import { z } from "zod";
import { defineTool, type ToolCallContext } from "@/core/define-tool";
import { resolveTier } from "@/core/resolve-tier";
import {
  type StudioContext,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import { createClusterResearchJob } from "./research-job";
import {
  DEEP_RESEARCH_DESCRIPTION,
  type ResearchJob,
  type ResearchResult,
  shapeResearchResult,
  WEB_SEARCH_DESCRIPTION,
  WebSearchInputSchema,
} from "@/harnesses/lib/decopilot/built-in-tools/web-search";
import {
  requireTaskRunContext,
  taskRunContextStore,
} from "../task-board/task-run-context";

/** Under Claude Code's 5-minute idle watchdog, so a stall fails here first, with a reason. */
const RESEARCH_STALL_MS = 3 * 60_000;

const PROGRESS_MESSAGE_CHARS = 200;

const ResearchOutputSchema = z.object({
  success: z.literal(true),
  query: z.string(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  content: z.string().optional(),
  uri: z.string().optional(),
  preview: z.string().optional(),
  citations: z
    .array(z.object({ url: z.string(), title: z.string().optional() }))
    .optional(),
});

export class ResearchStalledError extends Error {
  constructor(stallMs: number) {
    super(`Research made no progress for ${Math.round(stallMs / 1000)}s.`);
    this.name = "ResearchStalledError";
  }
}

/**
 * Drive a research job to its result, relaying each step as progress and
 * aborting the job once no step has arrived for `stallMs`. Progress is
 * best-effort: a client that went away aborts the call through its signal.
 */
export async function driveResearch(
  job: ResearchJob,
  params: { query: string; taskId: string; toolCallId: string },
  call: ToolCallContext | undefined,
  stallMs = RESEARCH_STALL_MS,
): Promise<ResearchResult> {
  const stalled = new AbortController();
  const research = job({
    ...params,
    abortSignal: call?.signal
      ? AbortSignal.any([call.signal, stalled.signal])
      : stalled.signal,
  });
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ResearchStalledError(stallMs);
        stalled.abort(error);
        reject(error);
      }, stallMs);
    });
    try {
      const step = await Promise.race([research.next(), stall]);
      if (step.done) return step.value;
      await call
        ?.progress?.(progressMessage(step.value.progress))
        .catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }
}

function progressMessage(transcript: string): string {
  const text = transcript.replace(/\s+/g, " ").trim();
  return text.length > PROGRESS_MESSAGE_CHARS
    ? `…${text.slice(-PROGRESS_MESSAGE_CHARS)}`
    : text || "Researching…";
}

async function research(
  ctx: StudioContext,
  call: ToolCallContext | undefined,
  input: { query: string },
  mode: "quick" | "deep",
  taskId: string,
) {
  const organization = requireOrganization(ctx);
  const toolName = mode === "quick" ? "web_search" : "deep_research";
  const tier = await resolveTier(ctx, toolName);
  const provider = await ctx.aiProviders.activate(
    tier.credentialId,
    organization.id,
  );
  const job = createClusterResearchJob({
    provider,
    modelInfo: { id: tier.modelId },
    ctx,
    mode,
    toolName,
  });
  const result = await driveResearch(
    job,
    {
      query: input.query,
      taskId,
      toolCallId: call?.callId ?? crypto.randomUUID(),
    },
    call,
  );
  return shapeResearchResult({
    query: input.query,
    ...result,
    resultUri: result.resultUri ?? null,
    preview: result.preview ?? "",
  });
}

export const WEB_SEARCH = defineTool({
  name: "web_search",
  description: WEB_SEARCH_DESCRIPTION,
  annotations: {
    title: "Web Search",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: WebSearchInputSchema,
  outputSchema: ResearchOutputSchema,
  requiresAiBudget: true,
  handler: async (input, ctx, call) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    // The quick path streams and persists nothing, so it needs no thread.
    const threadId = taskRunContextStore.getStore()?.threadId ?? "";
    return research(ctx, call, input, "quick", threadId);
  },
});

export const DEEP_RESEARCH = defineTool({
  name: "deep_research",
  description: DEEP_RESEARCH_DESCRIPTION,
  annotations: {
    title: "Deep Research",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: WebSearchInputSchema,
  outputSchema: ResearchOutputSchema,
  requiresAiBudget: true,
  handler: async (input, ctx, call) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    // The async path records its job against the thread.
    const { threadId } = requireTaskRunContext();
    return research(ctx, call, input, "deep", threadId);
  },
});
