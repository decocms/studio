/**
 * Site tokens of a hosted v8 site: what the site passes as
 * `createCMS({ site, token })` to send telemetry. A token is shown once;
 * at most two are active at a time (issue the new one, deploy it, revoke
 * the old one). Revoking takes effect at the edge.
 */

import { useState } from "react";
import { Copy01, Key01, Plus, Trash01 } from "@untitledui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  SettingsCard,
  SettingsCardRow,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import { formatTimeAgo } from "@/lib/format-time.ts";
import { KEYS } from "@/lib/query-keys";

const MAX_ACTIVE = 2;

interface SiteTokenRecord {
  kid: string;
  iat: number;
  revokedAt?: string;
}

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export function SiteTokenSection({
  orgSlug,
  virtualMcpId,
}: {
  orgSlug: string;
  virtualMcpId: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const base = `/api/${orgSlug}/hosted/${encodeURIComponent(virtualMcpId)}/site-tokens`;
  const key = KEYS.hostedSiteTokens(orgSlug, virtualMcpId);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<SiteTokenRecord | null>(null);

  const list = useQuery({
    queryKey: key,
    queryFn: async () =>
      readJson<{ site: string; tokens: SiteTokenRecord[] }>(await fetch(base)),
  });
  const issue = useMutation({
    mutationFn: async () =>
      readJson<{ token: string }>(await fetch(base, { method: "POST" })),
    onSuccess: ({ token }) => setCreated(token),
    onError: (error) =>
      toast.error(
        error.message === "too-many-tokens"
          ? t("siteTokens.tooMany")
          : error.message,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const revoke = useMutation({
    mutationFn: async (kid: string) =>
      readJson<unknown>(
        await fetch(`${base}/${encodeURIComponent(kid)}`, { method: "DELETE" }),
      ),
    onSuccess: () => toast.success(t("siteTokens.revoked")),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const tokens = list.data?.tokens ?? [];
  const active = tokens.filter((token) => !token.revokedAt).length;

  return (
    <SettingsSection
      title={t("siteTokens.title")}
      description={t("siteTokens.description")}
    >
      <SettingsCard>
        <SettingsCardRow>
          <div className="flex w-full items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("siteTokens.siteId")}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {list.data?.site ?? "—"}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={!list.data || active >= MAX_ACTIVE || issue.isPending}
              title={active >= MAX_ACTIVE ? t("siteTokens.tooMany") : undefined}
              onClick={() => issue.mutate()}
            >
              {issue.isPending ? (
                <Spinner className="size-3.5" />
              ) : (
                <Plus size={14} />
              )}
              {t("siteTokens.issue")}
            </Button>
          </div>
        </SettingsCardRow>
        {list.isError ? (
          <SettingsCardRow>
            <p className="text-xs text-destructive">{list.error.message}</p>
          </SettingsCardRow>
        ) : null}
        {tokens.map((token) => (
          <SettingsCardRow key={token.kid}>
            <div className="flex w-full items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Key01 size={16} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{token.kid}</p>
                  <p className="text-xs text-muted-foreground">
                    {token.revokedAt
                      ? t("siteTokens.revokedAgo", {
                          when: formatTimeAgo(new Date(token.revokedAt)),
                        })
                      : t("siteTokens.issuedAgo", {
                          when: formatTimeAgo(new Date(token.iat * 1000)),
                        })}
                  </p>
                </div>
              </div>
              {token.revokedAt ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => setRevoking(token)}
                >
                  <Trash01 size={14} />
                  {t("siteTokens.revoke")}
                </Button>
              )}
            </div>
          </SettingsCardRow>
        ))}
      </SettingsCard>

      <Dialog
        open={created !== null}
        onOpenChange={(o) => !o && setCreated(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("siteTokens.createdTitle")}</DialogTitle>
            <DialogDescription>
              {t("siteTokens.createdDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={created ?? ""}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                if (!created) return;
                void navigator.clipboard?.writeText(created);
                toast.success(t("siteTokens.copied"));
              }}
              aria-label={t("siteTokens.copy")}
            >
              <Copy01 size={14} />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>
              {t("siteTokens.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("siteTokens.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("siteTokens.revokeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("siteTokens.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revoking) revoke.mutate(revoking.kid);
                setRevoking(null);
              }}
            >
              {t("siteTokens.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
