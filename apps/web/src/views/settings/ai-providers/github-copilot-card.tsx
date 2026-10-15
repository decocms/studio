/**
 * Link your own GitHub Copilot plan, so sandbox-hosted claude-code runs reach
 * Claude through Copilot and bill your seat instead of the org's AI credit.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";

const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

export function GithubCopilotCard() {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");

  const status = useQuery({
    queryKey: KEYS.githubCopilot(org.id),
    queryFn: () => studio.call("GITHUB_COPILOT_STATUS", {}),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: KEYS.githubCopilot(org.id) });

  const connect = useMutation({
    mutationFn: () => studio.call("GITHUB_COPILOT_CONNECT", { token }),
    onSuccess: async () => {
      setToken("");
      await invalidate();
      toast.success(t("settings.githubCopilot.connected"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const disconnect = useMutation({
    mutationFn: () => studio.call("GITHUB_COPILOT_DISCONNECT", {}),
    onSuccess: async () => {
      await invalidate();
      toast.success(t("settings.githubCopilot.disconnected"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const connected = status.data?.connected === true;

  return (
    <div className="rounded-xl border border-border px-6 py-5 flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold">
            {t("settings.githubCopilot.title")}
          </p>
          <p className="text-sm text-muted-foreground">
            {connected
              ? t("settings.githubCopilot.active")
              : t("settings.githubCopilot.description")}
          </p>
        </div>
        {connected ? (
          <Button
            variant="outline"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {t("settings.githubCopilot.disconnect")}
          </Button>
        ) : null}
      </div>
      {connected ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            <a
              className="underline"
              href={NEW_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("settings.githubCopilot.howTo")}
            </a>
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("settings.githubCopilot.tokenPlaceholder")}
            />
            <Button
              disabled={token.trim().length === 0 || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {t("settings.githubCopilot.connect")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
