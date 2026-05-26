import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash01, LinkExternal01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  useGitInstallations,
  type GitProviderInstallation,
} from "@/web/hooks/collections/use-git-providers";
import { KEYS } from "@/web/lib/query-keys";

export function GitProviderInstallationsList() {
  const installations = useGitInstallations();
  if (installations.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium">Connected installations</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Agents in this org can act on these GitHub accounts.
        </p>
      </div>
      <ul className="divide-y divide-border">
        {installations.map((inst) => (
          <InstallationRow key={inst.id} installation={inst} />
        ))}
      </ul>
    </div>
  );
}

function InstallationRow({
  installation,
}: {
  installation: GitProviderInstallation;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  const { mutate: remove, isPending } = useMutation({
    mutationFn: async () => {
      const result = (await client.callTool({
        name: "GIT_PROVIDER_INSTALLATION_DELETE",
        arguments: { id: installation.id },
      })) as { structuredContent?: { githubRevokeUrl?: string } };
      return result.structuredContent;
    },
    onSuccess: (data) => {
      toast.success(
        data?.githubRevokeUrl
          ? "Removed from Studio. Also revoke on GitHub to stop access."
          : "Installation removed",
        data?.githubRevokeUrl
          ? {
              action: {
                label: "Revoke on GitHub",
                onClick: () => window.open(data.githubRevokeUrl, "_blank"),
              },
            }
          : undefined,
      );
      queryClient.invalidateQueries({
        queryKey: KEYS.gitProviderInstallations(org.id),
      });
    },
    onError: (e: Error) => toast.error(`Remove failed: ${e.message}`),
  });

  const accountUrl = `https://github.com/${installation.accountLogin}`;

  return (
    <li className="px-4 py-3 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <img
          src={`https://avatars.githubusercontent.com/u/${installation.accountId}?v=4`}
          alt=""
          className="size-8 rounded-full bg-muted shrink-0"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">
              {installation.accountLogin}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {installation.accountType === "Organization" ? "Org" : "User"}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {installation.repositorySelection === "all"
              ? "All repositories"
              : "Selected repositories"}{" "}
            · installed {new Date(installation.createdAt).toLocaleDateString()}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => window.open(accountUrl, "_blank")}
          aria-label="Open on GitHub"
        >
          <LinkExternal01 size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => remove()}
          aria-label="Remove installation"
        >
          <Trash01 size={14} />
        </Button>
      </div>
    </li>
  );
}
