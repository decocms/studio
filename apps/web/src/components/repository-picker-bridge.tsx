/**
 * `GitHubRepoPicker`'s first-class-repository path.
 *
 * Keeps the picker's public contract (`GitHubImportPayload`, the optional
 * agent creation, the post-import navigation) while sourcing the repository
 * from `RepositoryPicker` — the org's git provider accounts — rather than a
 * GitHub App installation and a per-repo `mcp-github` connection.
 *
 * The created agent records `metadata.githubRepo.repositoryId`, which is what
 * `SANDBOX_START` resolves credentials from; `owner`/`name`/`url` stay for the
 * legacy readers and for display.
 *
 * Every project opens on Site Editor regardless of provider: reading the
 * decofile and opening a change request both go through the provider
 * interface now, so there is nothing left for the editor to be unable to do on
 * a GitLab repository.
 */

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SELF_MCP_ALIAS_ID, useMCPClient, useProjectContext } from "@/sdk";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import {
  invalidateConnectionQueries,
  invalidateVirtualMcpQueries,
} from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import type { Repository } from "@/hooks/use-git-providers";
import { RepositoryPicker } from "@/components/repository-picker";
import type {
  GitHubImportPayload,
  Repo,
} from "@/components/github-repo-picker";

/** The picker's legacy repo shape, from a first-class repository row. */
function toRepo(repository: Repository): Repo {
  const segments = repository.path.split("/");
  const name = segments[segments.length - 1] ?? repository.path;
  return {
    owner: segments.slice(0, -1).join("/"),
    name,
    fullName: repository.path,
    url: repository.webUrl,
    private: repository.visibility !== "public",
    description: null,
    updatedAt: repository.updatedAt,
    fork: false,
  };
}

/**
 * The project a repository is imported as.
 *
 * Pure, and separate from the call, because it is a WIRE CONTRACT with
 * `COLLECTION_VIRTUAL_MCP_CREATE` — and one this file already got wrong once:
 * `connections` is required by the tool's schema, so omitting it made every
 * import fail with a 400 and create nothing, while the picker closed as if it
 * had worked. Empty is the correct value here (see the field's note), but the
 * key has to be present, and a test can say so.
 */
export function agentPayload(
  repository: Pick<Repository, "id">,
  repo: Pick<Repo, "name" | "owner" | "url">,
  opts: { description: string },
) {
  return {
    title: repo.name,
    description: opts.description,
    pinned: false,
    icon: null,
    metadata: {
      githubRepo: {
        owner: repo.owner,
        name: repo.name,
        url: repo.url,
        /** What `SANDBOX_START` and every provider client resolve from. */
        repositoryId: repository.id,
      },
      instructions: null,
      ui: {
        pinnedViews: null,
        layout: {
          defaultMainView: { type: "site-editor" as const },
          chatDefaultOpen: true,
        },
      },
    },
    /**
     * Empty, and required: a repository-backed project has no per-repo
     * connection to attach — its credential comes from the repository's git
     * provider account. The legacy picker passes the `mcp-github` child it
     * provisions, which is the only reason this field ever carried anything.
     */
    connections: [],
  };
}

export function RepositoryPickerBridge({
  open,
  onOpenChange,
  title,
  onImportComplete,
  mode = "agent",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  onImportComplete?: (payload: GitHubImportPayload) => void;
  mode?: "agent" | "connection";
}) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const navigateToAgent = useNavigateToAgent();
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const resolvedTitle =
    title ??
    (mode === "connection"
      ? t("common.githubRepoPicker.addRepo")
      : t("common.githubRepoPicker.importFromGitHub"));

  async function createAgent(repository: Repository, repo: Repo) {
    const result = (await selfClient.callTool({
      name: "COLLECTION_VIRTUAL_MCP_CREATE",
      arguments: {
        data: agentPayload(repository, repo, {
          description: t("common.repositoryPicker.agentDescription", {
            path: repository.path,
          }),
        }),
      },
    })) as { structuredContent?: unknown };
    const payload = (result.structuredContent ?? result) as {
      item?: { id: string };
    };
    const virtualMcpId = payload.item?.id;
    if (!virtualMcpId) {
      throw new Error(t("common.repositoryPicker.createAgentFailed"));
    }
    return virtualMcpId;
  }

  function handlePicked(repository: Repository) {
    const repo = toRepo(repository);
    onOpenChange(false);

    if (mode === "connection") {
      invalidateVirtualMcpQueries(queryClient, org.id);
      invalidateConnectionQueries(queryClient, org.id);
      if (onImportComplete) {
        onImportComplete({
          virtualMcpId: null,
          repo,
          connectionId: null,
          repositoryId: repository.id,
        });
        return;
      }
      toast.success(
        t("common.githubRepoPicker.addedRepo", { name: repo.name }),
      );
      return;
    }

    createAgent(repository, repo)
      .then((virtualMcpId) => {
        invalidateVirtualMcpQueries(queryClient, org.id);
        if (onImportComplete) {
          onImportComplete({
            virtualMcpId,
            repo,
            connectionId: null,
            repositoryId: repository.id,
          });
          return;
        }
        toast.success(
          t("common.githubRepoPicker.importedRepo", { name: repo.name }),
        );
        navigateToAgent(virtualMcpId);
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error
            ? err.message
            : t("common.repositoryPicker.createAgentFailed"),
        );
      });
  }

  return (
    <RepositoryPicker
      open={open}
      onOpenChange={onOpenChange}
      title={resolvedTitle}
      onPicked={({ repository }) => handlePicked(repository)}
      onError={(message) => toast.error(message)}
    />
  );
}
