import { useQuery } from "@tanstack/react-query";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { KEYS } from "@/lib/query-keys";
import { decoRepoPath } from "@/components/sections-editor/deco-repo-path";
import { readCommittedJson } from "@/components/sections-editor/read-committed-file";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { usePackagePath } from "@/components/sections-editor/use-package-path";
import { useVirtualMCP } from "@/sdk";
import { type BlogSupport, blogSupport } from "./blog-capabilities";

interface UseBlogSupportParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** Schema for the same branch — the fallback version source. */
  meta: LiveMeta | null | undefined;
}

/**
 * What the blog CMS may offer for this project: the detected runtime plus the
 * deco-apps version this branch pins, read from the committed `deno.json` and
 * falling back to the schema already in hand.
 *
 * Resolves to `unsupported-runtime` on a non-Deno or undetected runtime, so the
 * UI never offers scheduling it can't back.
 */
export function useBlogSupport(params: UseBlogSupportParams): BlogSupport {
  const packageManager =
    useVirtualMCP(params.virtualMcpId)?.metadata?.runtime?.selected ?? null;
  const packagePath = usePackagePath(params.virtualMcpId);
  // Read from the same session as every other committed read (see useSaveBlock).
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const { data: denoJson } = useQuery({
    queryKey: KEYS.denoJson(params.orgSlug, params.virtualMcpId, params.branch),
    queryFn: async () => {
      const read = await readCommittedJson<unknown>(
        { ...params, threadId },
        decoRepoPath(packagePath, "deno.json"),
      );
      return read.kind === "data" ? read.data : null;
    },
    enabled: packageManager === "deno",
    staleTime: 300_000,
  });
  return blogSupport({
    packageManager,
    denoJson: denoJson ?? null,
    meta: params.meta,
  });
}
