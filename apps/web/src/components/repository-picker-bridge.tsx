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
        data: {
          title: repo.name,
          description: t("common.repositoryPicker.agentDescription", {
            path: repository.path,
          }),
          pinned: false,
          icon: null,
          metadata: {
            githubRepo: {
              owner: repo.owner,
              name: repo.name,
              url: repo.url,
              repositoryId: repository.id,
            },
            instructions: null,
            ui: {
              pinnedViews: null,
              layout: {
                /**
                 * Site Editor reads the decofile over GitHub's Git Data API,
                 * so a GitLab repository would land on a view that cannot
                 * load. Those projects open on Chat — the coding agent, which
                 * does work — until the editor speaks both providers.
                 */
                defaultMainView: {
                  type:
                    repository.provider === "github" ? "site-editor" : "chat",
                },
                chatDefaultOpen: true,
              },
            },
          },
        },
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
