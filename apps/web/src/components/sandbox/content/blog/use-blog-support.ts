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
 * What the blog CMS may offer here: the detected runtime plus the blog-app
 * version this branch pins — `deno.json` on Deno (falling back to the schema in
 * hand), `package.json` elsewhere.
 *
 * Fails closed to `unsupported-runtime`, so the UI never offers scheduling it
 * can't back.
 */
export function useBlogSupport(params: UseBlogSupportParams): BlogSupport {
  const packageManager =
    useVirtualMCP(params.virtualMcpId)?.metadata?.runtime?.selected ?? null;
  const packagePath = usePackagePath(params.virtualMcpId);
  // Read from the same session as every other committed read (see useSaveBlock).
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const readJson = async (file: string) => {
    const read = await readCommittedJson<unknown>(
      { ...params, threadId },
      decoRepoPath(packagePath, file),
    );
    return read.kind === "data" ? read.data : null;
  };
  const { data: denoJson } = useQuery({
    queryKey: KEYS.denoJson(params.orgSlug, params.virtualMcpId, params.branch),
    queryFn: () => readJson("deno.json"),
    enabled: packageManager === "deno",
    staleTime: 300_000,
  });
  const { data: packageJson } = useQuery({
    queryKey: KEYS.packageJson(
      params.orgSlug,
      params.virtualMcpId,
      params.branch,
    ),
    queryFn: () => readJson("package.json"),
    enabled: packageManager !== null && packageManager !== "deno",
    staleTime: 300_000,
  });
  return blogSupport({
    packageManager,
    denoJson: denoJson ?? null,
    packageJson: packageJson ?? null,
    meta: params.meta,
  });
}
