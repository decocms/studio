import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SELF_MCP_ALIAS_ID, useMCPClient, useProjectContext } from "@/sdk";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { invalidateVirtualMcpQueries } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import type { Repository } from "@/hooks/use-git-providers";
import { RepositoryPicker } from "@/components/repository-picker";
interface RepositoryImportPayload {
  virtualMcpId: string | null;
  repository: Repository;
}
interface Repo {
  owner: string;
  name: string;
  url: string;
}

/** The picker's legacy repo shape, from a first-class repository row. */
function toRepo(repository: Repository): Repo {
  const segments = repository.path.split("/");
  const name = segments[segments.length - 1] ?? repository.path;
  return {
    owner: segments.slice(0, -1).join("/"),
    name,
    url: repository.webUrl,
  };
}

/** Keep the legacy metadata alongside the repository reference during rollout. */
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
    // The tool requires connections, even for a repository-backed agent.
    connections: [],
  };
}

export function RepositoryImportPicker({
  open,
  onOpenChange,
  title,
  onImportComplete,
  mode = "agent",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  onImportComplete?: (payload: RepositoryImportPayload) => void;
  mode?: "agent" | "link";
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
    (mode === "link"
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

  async function handlePicked(repository: Repository) {
    const repo = toRepo(repository);
    const virtualMcpId =
      mode === "agent" ? await createAgent(repository, repo) : null;
    invalidateVirtualMcpQueries(queryClient, org.id);
    onOpenChange(false);
    if (onImportComplete) {
      onImportComplete({
        virtualMcpId,
        repository,
      });
    } else if (virtualMcpId) {
      toast.success(
        t("common.githubRepoPicker.importedRepo", { name: repo.name }),
      );
      navigateToAgent(virtualMcpId);
    } else {
      toast.success(
        t("common.githubRepoPicker.addedRepo", { name: repo.name }),
      );
    }
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
