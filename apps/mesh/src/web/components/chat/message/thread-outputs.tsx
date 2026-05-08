/**
 * ThreadOutputs — download chips for files the model has shared back
 * to the user via the `share_with_user` tool. Files live under
 * `model-outputs/<thread_id>/` and are listed by
 * `GET /api/:org/threads/:threadId/outputs`. The query is invalidated on
 * assistant-turn completion (see useStreamManager + chat onFinish).
 *
 * Attribution caveat: outputs are aggregated under the *last* assistant
 * message of the thread rather than per-producing-message. Future
 * iterations can encode the message id in the storage key to attribute
 * each chip to its producing turn.
 */

import { useQuery } from "@tanstack/react-query";
import { Download01 } from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { KEYS } from "../../../lib/query-keys";

interface ThreadOutput {
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ThreadOutputs({ threadId }: { threadId: string }) {
  const { org } = useProjectContext();
  const { data: outputs } = useQuery({
    queryKey: KEYS.threadOutputs(threadId),
    queryFn: () => fetchThreadOutputs(threadId, org.slug),
    // Stale immediately so refetch on invalidation is fresh.
    staleTime: 0,
  });

  if (!outputs || outputs.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="text-[12px] text-muted-foreground/70 uppercase tracking-wide">
        Files shared in this chat
      </div>
      <div className="flex flex-wrap gap-2">
        {outputs.map((file) => (
          <a
            key={file.key}
            href={file.downloadUrl}
            download={file.filename}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 text-[13px] transition-colors"
          >
            <Download01 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium text-foreground">{file.filename}</span>
            <span className="text-muted-foreground">
              {formatSize(file.size)}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
