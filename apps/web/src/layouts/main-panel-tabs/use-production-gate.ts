import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useOptionalChatTask } from "@/components/chat/context";
import { sandboxGitStatusQueryOptions } from "@/components/thread/repository/sandbox-git-api";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { type ProductionGate, resolveProductionGate } from "./production-gate";

/**
 * {@link resolveProductionGate} for the current session. The default branch
 * is the server's own answer (`/git/status` `base`), read through the same
 * cache entry as the Fast Preview header — `useBaseBranch` only knows a PR's
 * base and says "main" on production.
 */
export function useProductionGate(): ProductionGate {
  const session = useOptionalChatTask();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(session?.virtualMcpId);
  const virtualMcpId = entity?.id ?? session?.virtualMcpId ?? "";
  const branch = session?.currentBranch ?? null;
  const { runtime, resolved } = useSessionRuntime(entity?.id);
  const siteMajor = useMainSchemaV8(entity?.id);
  const { url: localPreviewUrl, undecided: tunnelUndecided } =
    useLocalPreviewUrl(entity?.id);
  const { connection: serveConnection } = useDecoServeConnection(
    virtualMcpId || null,
  );
  const asksDefaultBranch =
    !!entity &&
    !!branch &&
    resolved &&
    runtime === "cms" &&
    siteMajor === "v7" &&
    !localPreviewUrl;
  const status = useQuery({
    ...sandboxGitStatusQueryOptions({
      orgSlug: org.slug,
      virtualMcpId,
      branch: branch ?? "",
      threadId: session?.taskId ?? null,
    }),
    enabled: asksDefaultBranch,
    // The default branch is the repo's, not the branch's: switching drafts
    // keeps the last answer instead of unmounting the editor to wait again.
    placeholderData: keepPreviousData,
  });
  return resolveProductionGate({
    runtime,
    runtimeResolved: resolved,
    siteMajor,
    localPreview: !!localPreviewUrl,
    tunnelUndecided: !!tunnelUndecided,
    servingLocally: !!serveConnection,
    branch,
    defaultBranch: status.isError
      ? null
      : status.data
        ? (status.data.base ?? null)
        : undefined,
  });
}
