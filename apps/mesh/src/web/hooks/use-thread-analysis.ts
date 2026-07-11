/**
 * useThreadAnalysis — the "what's happening here" read for a home card.
 *
 * Grounded in the thread's actual content: it pulls the most recent messages
 * (COLLECTION_THREAD_MESSAGES_LIST, frontend-callable over the org's self-MCP)
 * and distills the latest agent activity into one line. Cached per
 * (threadId, updated_at) so a new message re-summarizes and nothing else does.
 *
 * Only fetched for *active* threads (the moving pieces) — completed threads fall
 * back to the instant status heuristic, so the home doesn't fan out a message
 * read for every archived conversation.
 *
 * LLM UPGRADE SEAM: to replace the extractive summary with a generated one, swap
 * `summarizeMessages` for a call to a `THREAD_ANALYZE` backend tool (wrapping
 * LLM_DO_GENERATE with a model resolved via AI_PROVIDERS_LIST_MODELS). The hook
 * shape and caching stay identical.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { mcpClientQueryOptions, SELF_MCP_ALIAS_ID } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import type { MyThread } from "@/web/hooks/use-my-threads";

interface ThreadMessage {
  role: "user" | "assistant" | "system";
  parts?: unknown[];
}

/** Pull readable text out of an AI-SDK UIMessage part array. */
function textOf(parts: unknown[] | undefined): string {
  if (!parts) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    const p = part as { type?: string; text?: string };
    if (p.type === "text" && typeof p.text === "string") chunks.push(p.text);
  }
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

/** Describe a tool-call part ("Running X…") when the tail of the thread is an
 * in-flight tool rather than prose. */
function toolLabel(parts: unknown[] | undefined): string | null {
  if (!parts) return null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as { type?: string };
    if (typeof p.type === "string" && p.type.startsWith("tool-")) {
      return p.type.slice("tool-".length).replace(/[-_]/g, " ");
    }
  }
  return null;
}

/** Extractive one-liner: the latest assistant text, else the latest user ask. */
function summarizeMessages(messages: ThreadMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const text = textOf(m.parts);
    if (text) return text;
    const tool = toolLabel(m.parts);
    if (tool) return `Working on ${tool}`;
  }
  // No assistant output yet — echo what was asked.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      const text = textOf(m.parts);
      if (text) return text;
    }
  }
  return null;
}

export interface ThreadAnalysisResult {
  /** One-line, content-grounded summary — null while loading or unavailable. */
  summary: string | null;
  isLoading: boolean;
}

export function useThreadAnalysis(
  item: MyThread,
  options: { enabled?: boolean } = {},
): ThreadAnalysisResult {
  const queryClient = useQueryClient();
  const { thread, org } = item;
  // Active threads are the ones worth a content read; completed ones use the
  // heuristic verb (caller passes enabled accordingly, but default matches).
  const enabled = options.enabled ?? thread.status !== "completed";

  const query = useQuery({
    queryKey: KEYS.threadAnalysis(thread.id, thread.updated_at),
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<string | null> => {
      const client = await queryClient.ensureQueryData(
        mcpClientQueryOptions({
          connectionId: SELF_MCP_ALIAS_ID,
          orgId: org.id,
          orgSlug: org.slug,
        }),
      );
      const result = await client.callTool({
        name: "COLLECTION_THREAD_MESSAGES_LIST",
        arguments: {
          thread_id: thread.id,
          limit: 12,
          orderBy: [{ field: ["created_at"], direction: "asc" }],
        },
      });
      if ((result as { isError?: boolean }).isError) return null;
      const payload = ((result as { structuredContent?: unknown })
        .structuredContent ?? result) as { items?: ThreadMessage[] };
      return summarizeMessages(payload.items ?? []);
    },
  });

  return { summary: query.data ?? null, isLoading: query.isLoading && enabled };
}
