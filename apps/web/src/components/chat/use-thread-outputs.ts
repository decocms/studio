/**
 * useThreadOutputs — shared query for the files a thread has produced
 * (share_with_user uploads under `model-outputs/<threadId>/` merged with
 * org-fs `outputs/<threadId>/` writes), served by
 * `GET /api/:org/threads/:threadId/outputs`.
 *
 * Consumed by the per-turn rows (MessageProducedFiles), the
 * "Files in this task" pill (ThreadFilesPanel), and the file-preview tab
 * (FileTab), so all three render the same list and share one cache entry.
 * The fetch is gated on the thread having any file-producing tool part —
 * pure-chat threads pay zero network. The companion invalidation lives in
 * chat-context's onFinish handler.
 */

import { useQuery } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { KEYS } from "../../lib/query-keys";
import { useOptionalChatStream } from "./context.tsx";

export interface ThreadOutput {
  key: string;
  filename: string;
  size: number;
  uploadedAt?: string;
  downloadUrl: string;
}

interface ThreadOutputsResponse {
  objects: ThreadOutput[];
}

async function fetchThreadOutputs(
  threadId: string,
  orgSlug: string,
): Promise<ThreadOutput[]> {
  const res = await fetch(
    `/api/${orgSlug}/threads/${encodeURIComponent(threadId)}/outputs`,
    {
      credentials: "include",
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch thread outputs: ${res.status}`);
  }
  const body = (await res.json()) as ThreadOutputsResponse;
  return body.objects ?? [];
}

/**
 * True when any message has a tool part that could have produced a file:
 * an explicit share_with_user, or sandbox file work (bash/write can drop
 * results into `org/output/`).
 */
export function useThreadHasFileWork(): boolean {
  const messages = useOptionalChatStream()?.messages ?? [];
  return messages.some((m) =>
    m.parts?.some((p) => {
      const part = p as { type: string; state?: string };
      return (
        (part.type === "tool-share_with_user" ||
          part.type === "tool-bash" ||
          part.type === "tool-write") &&
        part.state === "output-available"
      );
    }),
  );
}

export function useThreadOutputs(
  threadId: string | null,
  opts?: { enabled?: boolean },
) {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.threadOutputs(threadId ?? ""),
    queryFn: () => fetchThreadOutputs(threadId ?? "", org.slug),
    enabled: Boolean(threadId) && (opts?.enabled ?? true),
    // Stale immediately so refetch on invalidation is fresh.
    staleTime: 0,
  });
}
