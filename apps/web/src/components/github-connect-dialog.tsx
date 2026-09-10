import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
    mutationFn: async (installationId: number) =>
      requestFlow(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId }),
      }),
    onSuccess: () => {
      broadcast(channelName, "complete");
      toast.success(t("settings.repositories.githubConnected"));
      finish();
    },
    onError: () => {
      void flow.refetch();
      toast.error(t("settings.repositories.oauthFailed"));
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
            {t("settings.repositories.addGithubAccount")}
          </DialogTitle>
          <DialogDescription>
            {t("settings.repositories.githubShareHint", {
              organization: org.name,
            })}
          </DialogDescription>
        </DialogHeader>
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
                onClick={() => connect.mutate(installation.installationId)}
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
        {!expired && (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            {t("settings.repositories.githubReturnHint")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
