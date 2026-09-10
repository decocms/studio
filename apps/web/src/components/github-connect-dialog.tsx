import { useState, useSyncExternalStore } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { ArrowRight, LinkExternal01, RefreshCw01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { GitHubIcon } from "@/components/icons/github-icon";
import { useGitProviderCapabilities } from "@/hooks/use-git-providers";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t";

const flowSchema = z.object({
  installations: z.array(
    z.object({
      installationId: z.number(),
      login: z.string(),
      avatarUrl: z.string().nullable(),
      /** Null when the whole account is on offer, a count when only part is. */
      repositoryCount: z.number().nullable(),
    }),
  ),
});

const repositoryPageSchema = z.object({
  repositories: z.array(z.object({ id: z.number(), name: z.string() })),
  hasMore: z.boolean(),
  accountVersion: z.string().nullable(),
});

type RepositoryGrant = {
  installationId: number;
  repositoryIds: number[];
  accountVersion: string | null;
};

class FlowError extends Error {
  constructor(readonly status: number) {
    super("GitHub connection request failed");
  }
}

async function requestFlow(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw new FlowError(response.status);
  return response;
}

const getSnapshot = () => null;

function broadcast(name: string, message: string) {
  const channel = new BroadcastChannel(name);
  channel.postMessage(message);
  channel.close();
}

export function GithubConnectDialog({
  flowId,
  returning,
  onClose,
}: {
  flowId: string;
  returning: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const [selectedInstallation, setSelectedInstallation] = useState<
    number | null
  >(null);
  const capabilities = useGitProviderCapabilities();
  const path = `/api/${encodeURIComponent(org.slug)}/git-providers/github/flows/${encodeURIComponent(flowId)}`;
  const channelName = `github-connect:${org.id}:${flowId}`;
  const flow = useQuery({
    queryKey: KEYS.githubConnectFlow(org.id, flowId),
    queryFn: async () =>
      flowSchema.parse(await (await requestFlow(path)).json()),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: "always",
  });

  function finish() {
    void queryClient.invalidateQueries({ queryKey: KEYS.gitAccounts(org.id) });
    void queryClient.invalidateQueries({ queryKey: KEYS.repositories(org.id) });
    void queryClient.invalidateQueries({
      queryKey: KEYS.providerRepoSearch(org.id, "", "").slice(0, 2),
    });
    onClose();
  }

  // The setup tab announces its return. Only close it after the original tab
  // acknowledges receipt; a standalone return still has a usable picker.
  useSyncExternalStore(
    () => {
      const channel = new BroadcastChannel(channelName);
      // Separate GitHub windows can leave this document visible while unfocused.
      const refresh = () => {
        if (!returning) void flow.refetch({ cancelRefetch: false });
      };
      window.addEventListener("focus", refresh);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "refresh" && !returning) {
          void flow.refetch();
          channel.postMessage("ack");
        } else if (event.data === "ack" && returning) {
          window.close();
        } else if (event.data === "complete") {
          finish();
        }
      };
      if (returning) channel.postMessage("refresh");
      return () => {
        window.removeEventListener("focus", refresh);
        channel.close();
      };
    },
    getSnapshot,
    getSnapshot,
  );

  const connect = useMutation({
    mutationFn: async (grant: RepositoryGrant) =>
      requestFlow(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(grant),
      }),
    onSuccess: () => {
      broadcast(channelName, "complete");
      toast.success(t("settings.repositories.githubConnected"));
      finish();
    },
    onError: (error) => {
      toast.error(
        t(
          error instanceof FlowError && error.status === 409
            ? "settings.repositories.githubAccessChanged"
            : "settings.repositories.oauthFailed",
        ),
      );
    },
  });
  const cancel = useMutation({
    mutationFn: () => requestFlow(path, { method: "DELETE" }),
    onSuccess: onClose,
    onError: () => toast.error(t("settings.repositories.failed")),
  });
  const returnTo = `/${org.slug}/settings/repositories?git_flow=${flowId}&git_return=true`;
  const installPath = capabilities.data?.github.installPath;
  const installUrl = installPath
    ? `${installPath}?returnTo=${encodeURIComponent(returnTo)}`
    : undefined;
  const connectPath = capabilities.data?.github.connectPath;
  const restartUrl = connectPath
    ? `${connectPath}?returnTo=${encodeURIComponent(`/${org.slug}/settings/repositories`)}`
    : undefined;
  const expired = flow.error instanceof FlowError && flow.error.status === 410;
  const busy = connect.isPending || cancel.isPending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) cancel.mutate();
      }}
    >
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 py-4 border-b border-border">
          <DialogTitle>
            {t(
              selectedInstallation === null
                ? "settings.repositories.addGithubAccount"
                : "settings.repositories.githubSelectTitle",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              selectedInstallation === null
                ? "settings.repositories.githubShareHint"
                : "settings.repositories.githubSelectedShareHint",
              {
                organization: org.name,
              },
            )}
          </DialogDescription>
        </DialogHeader>
        {selectedInstallation !== null ? (
          <RepositoryGrantPicker
            key={selectedInstallation}
            path={path}
            orgId={org.id}
            flowId={flowId}
            installationId={selectedInstallation}
            busy={busy}
            changed={
              connect.error instanceof FlowError && connect.error.status === 409
            }
            onConnect={(grant) => connect.mutate(grant)}
            onBack={() => {
              setSelectedInstallation(null);
              connect.reset();
            }}
          />
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {flow.isPending ? (
              <div className="p-4">
                <Skeleton className="h-20 w-full" />
              </div>
            ) : flow.isError ? (
              <p role="alert" className="p-4 text-sm text-destructive">
                {t(
                  expired
                    ? "settings.repositories.oauthExpired"
                    : "settings.repositories.githubRefreshFailed",
                )}
              </p>
            ) : flow.data.installations.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t("settings.repositories.githubInstallHint")}
              </div>
            ) : (
              flow.data.installations.map((installation) => (
                <Button
                  key={installation.installationId}
                  variant="ghost"
                  disabled={busy || flow.isFetching}
                  className="w-full h-auto rounded-none justify-start gap-3 px-4 py-3"
                  onClick={() =>
                    setSelectedInstallation(installation.installationId)
                  }
                >
                  <Avatar
                    url={installation.avatarUrl ?? undefined}
                    fallback={<GitHubIcon size={16} />}
                    size="sm"
                    shape="circle"
                    muted
                  />
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block truncate">{installation.login}</span>
                    {installation.repositoryCount !== null && (
                      <span className="block truncate text-xs text-muted-foreground font-normal">
                        {t(
                          installation.repositoryCount === 1
                            ? "settings.repositories.githubAdministeredOne"
                            : "settings.repositories.githubAdministered",
                          { count: String(installation.repositoryCount) },
                        )}
                      </span>
                    )}
                  </span>
                  <ArrowRight size={16} />
                </Button>
              ))
            )}
          </div>
        )}
        {selectedInstallation === null && (
          <div className="border-t border-border px-4 py-3 flex flex-wrap gap-2">
            {!expired && installUrl && (
              <Button variant="outline" size="sm" asChild disabled={busy}>
                <a
                  href={busy ? undefined : installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-disabled={busy}
                >
                  <LinkExternal01 size={14} />
                  {t("settings.repositories.installGithubAccount")}
                </a>
              </Button>
            )}
            {!expired && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || flow.isFetching}
                onClick={() => void flow.refetch()}
              >
                <RefreshCw01 size={14} />
                {t("settings.repositories.checkGithubAccess")}
              </Button>
            )}
            {restartUrl && (
              <Button variant="ghost" size="sm" asChild disabled={busy}>
                <a href={busy ? undefined : restartUrl} aria-disabled={busy}>
                  {t(
                    expired
                      ? "settings.repositories.tryAgain"
                      : "settings.repositories.switchGithubUser",
                  )}
                </a>
              </Button>
            )}
          </div>
        )}
        {!expired && selectedInstallation === null && (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            {t("settings.repositories.githubReturnHint")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RepositoryGrantPicker({
  path,
  orgId,
  flowId,
  installationId,
  busy,
  changed,
  onConnect,
  onBack,
}: {
  path: string;
  orgId: string;
  flowId: string;
  installationId: number;
  busy: boolean;
  changed: boolean;
  onConnect: (grant: RepositoryGrant) => void;
  onBack: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const repositories = useInfiniteQuery({
    queryKey: KEYS.githubConnectRepositories(orgId, flowId, installationId),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) =>
      repositoryPageSchema.parse(
        await (
          await requestFlow(
            `${path}/repositories?installationId=${installationId}&page=${pageParam}`,
          )
        ).json(),
      ),
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.length + 1 : undefined,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const first = repositories.data?.pages[0];
  const choices = [
    ...new Map(
      repositories.data?.pages
        .flatMap((page) => page.repositories)
        .map((repo) => [repo.id, repo]),
    ).values(),
  ];
  return (
    <div className="p-4 space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("settings.repositories.githubSelectHint")}
      </p>
      {first?.accountVersion && (
        <p className="text-sm text-muted-foreground">
          {t("settings.repositories.githubReplaceHint")}
        </p>
      )}
      <Input
        aria-label={t("settings.repositories.githubFilterRepos")}
        placeholder={t("settings.repositories.githubFilterRepos")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {repositories.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <div className="max-h-64 overflow-y-auto space-y-2">
          {choices
            .filter((repo) =>
              repo.name.toLowerCase().includes(query.trim().toLowerCase()),
            )
            .map((repo) => (
              <label
                key={repo.id}
                className="flex items-center gap-2 text-sm py-1"
              >
                <Checkbox
                  checked={selected.includes(repo.id)}
                  disabled={
                    busy ||
                    (!selected.includes(repo.id) && selected.length >= 500)
                  }
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked === true
                        ? [...current, repo.id]
                        : current.filter((id) => id !== repo.id),
                    )
                  }
                />
                <span className="break-all">{repo.name}</span>
              </label>
            ))}
          {choices.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("settings.repositories.githubNoRepos")}
            </p>
          )}
        </div>
      )}
      {(repositories.isError || changed) && (
        <p role="alert" className="text-sm text-destructive">
          {t(
            changed
              ? "settings.repositories.githubAccessChanged"
              : "settings.repositories.githubRefreshFailed",
          )}
        </p>
      )}
      {repositories.isError && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void repositories.refetch()}
        >
          {t("settings.repositories.tryAgain")}
        </Button>
      )}
      {repositories.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          disabled={repositories.isFetching || busy}
          onClick={() => void repositories.fetchNextPage()}
        >
          {t("settings.repositories.githubMoreRepos")}
        </Button>
      )}
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" disabled={busy} onClick={onBack}>
          {t("settings.repositories.githubBack")}
        </Button>
        <Button
          disabled={
            busy ||
            changed ||
            !first ||
            repositories.isError ||
            selected.length === 0
          }
          onClick={() => {
            if (first)
              onConnect({
                installationId,
                repositoryIds: selected,
                accountVersion: first.accountVersion,
              });
          }}
        >
          {t(
            selected.length === 1
              ? "settings.repositories.githubSaveOneRepo"
              : "settings.repositories.githubSaveRepos",
            {
              count: String(selected.length),
            },
          )}
        </Button>
      </div>
    </div>
  );
}
