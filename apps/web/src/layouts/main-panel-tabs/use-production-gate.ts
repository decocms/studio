import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOptionalChatTask } from "@/components/chat/context";
import {
  sandboxGitStatusQueryKey,
  sandboxGitStatusQueryOptions,
} from "@/components/thread/repository/sandbox-git-api";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useBlocksV8Project } from "@/hooks/use-blocks-v8-project";
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
  const blocksV8 = useBlocksV8Project(entity?.id);
  const { url: localPreviewUrl } = useLocalPreviewUrl(entity?.id);
  const { connection: serveConnection } = useDecoServeConnection(
    virtualMcpId || null,
  );
  const asksDefaultBranch =
    !!entity &&
    !!branch &&
    resolved &&
    runtime === "cms" &&
    !blocksV8 &&
    !localPreviewUrl;
  const statusRef = {
    orgSlug: org.slug,
    virtualMcpId,
    branch: branch ?? "",
    threadId: session?.taskId ?? null,
  };
  const projectOf = (key: readonly unknown[] | undefined) => key?.[2];
  const status = useQuery({
    ...sandboxGitStatusQueryOptions(statusRef),
    enabled: asksDefaultBranch,
    // The default branch is the repo's, not the branch's: another draft of
    // the same project answers it while this one's status loads.
    placeholderData: (previous, previousQuery) =>
      projectOf(previousQuery?.queryKey) ===
      projectOf(sandboxGitStatusQueryKey(statusRef))
        ? previous
        : undefined,
  });
  const gate = resolveProductionGate({
    runtime,
    runtimeResolved: resolved,
    blocksV8,
    localPreview: !!localPreviewUrl,
    servingLocally: !!serveConnection,
    branch,
    listedDraft: (entity?.metadata?.releases ?? []).some(
      (r) => r.branch === branch,
    ),
    // A failed refetch keeps the last answer: only a read that never
    // succeeded counts as unknown.
    defaultBranch: status.data
      ? (status.data.base ?? null)
      : status.isError
        ? null
        : undefined,
  });

  // Once decided for a branch, a later "pending" (the runtime or the
  // default branch read again) keeps the decision instead of unmounting the editor.
  const sessionKey = `${virtualMcpId}:${branch ?? ""}`;
  const [settled, setSettled] = useState<{
    key: string;
    gate: Exclude<ProductionGate, "pending">;
  } | null>(null);
  if (
    gate !== "pending" &&
    (settled?.key !== sessionKey || settled.gate !== gate)
  ) {
    setSettled({ key: sessionKey, gate });
  }
  return gate === "pending" && settled?.key === sessionKey
    ? settled.gate
    : gate;
}
