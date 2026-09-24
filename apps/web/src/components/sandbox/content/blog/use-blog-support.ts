import { useQuery } from "@tanstack/react-query";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { KEYS } from "@/lib/query-keys";
import { decoRepoPath } from "@/components/sections-editor/deco-repo-path";
import {
  type CommittedRead,
  readCommittedJson,
} from "@/components/sections-editor/read-committed-file";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { usePackagePath } from "@/components/sections-editor/use-package-path";
import { type BlogSupport, blogSupport } from "./blog-capabilities";

interface UseBlogSupportParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** Schema for the same branch — the fallback version source. */
  meta: LiveMeta | null | undefined;
}

/** A read still in flight is not a file that isn't there. */
const PENDING: CommittedRead<unknown> = { kind: "unavailable" };

/**
 * What the blog CMS may offer here: the blog-app version this branch pins, read
 * from both manifests the repo might commit. Which one answers is the repo's
 * call, not the runtime picker's — see {@link blogSupport}.
 *
 * Fails closed, so the UI never offers scheduling it can't back.
 */
export function useBlogSupport(params: UseBlogSupportParams): BlogSupport {
  const packagePath = usePackagePath(params.virtualMcpId);
  // Read from the same session as every other committed read (see useSaveBlock).
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const read = (file: string) => ({
    queryFn: () =>
      readCommittedJson<unknown>(
        { ...params, threadId },
        decoRepoPath(packagePath, file),
      ),
    staleTime: 300_000,
  });
  const { data: denoJson } = useQuery({
    queryKey: KEYS.denoJson(params.orgSlug, params.virtualMcpId, params.branch),
    ...read("deno.json"),
  });
  const { data: packageJson } = useQuery({
    queryKey: KEYS.packageJson(
      params.orgSlug,
      params.virtualMcpId,
      params.branch,
    ),
    ...read("package.json"),
  });
  return blogSupport({
    denoJson: denoJson ?? PENDING,
    packageJson: packageJson ?? PENDING,
    meta: params.meta,
  });
}
