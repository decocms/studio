/**
 * Site tokens of a hosted v8 site: what the site passes as
 * `createCMS({ site, token })` to send telemetry, next to the site id (the
 * only place settings show it; hover the row to copy it). A token is shown
 * once, in a dialog with its copy button; issuing always works, and the list
 * shows every live token (their key ids, never the tokens), each with a
 * revoke button. Keyed by the site on the hosted CMS
 * (`/api/cms/:site/site-tokens`).
 */

import { useId, useState } from "react";
import { Key01, Plus, Trash01 } from "@untitledui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { Button } from "@decocms/ui/components/button.tsx";
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
import { cmsUrl } from "@/components/sections-editor/cms-api";
import { CopyableField, CopyValueButton } from "./copy-value-button";

interface SiteTokenRecord {
  kid: string;
  iat: number;
}

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export function SiteTokenSection({
  orgSlug,
  virtualMcpId,
  site: projectSite,
}: {
  orgSlug: string;
  virtualMcpId: string;
  /** The project's site id (`metadata.siteSlug`). */
  site: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const base = cmsUrl(projectSite, "site-tokens");
  const key = KEYS.hostedSiteTokens(orgSlug, virtualMcpId);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const siteIdField = useId();

  const list = useQuery({
    queryKey: key,
    queryFn: async () =>
      readJson<{ site: string; tokens: SiteTokenRecord[] }>(await fetch(base)),
  });
  const issue = useMutation({
    mutationFn: async () =>
      readJson<{ token: string }>(await fetch(base, { method: "POST" })),
    onSuccess: ({ token }) => setCreated(token),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const revoke = useMutation({
    mutationFn: async (kid: string) =>
      readJson<{ revoked: true }>(
        await fetch(`${base}/${encodeURIComponent(kid)}`, {
          method: "DELETE",
        }),
      ),
    onSuccess: () => {
      setRevoking(null);
      toast.success(t("siteTokens.revoked"));
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const tokens = list.data?.tokens ?? [];
  const site = list.data?.site;

  return (
    <SettingsSection
      title={t("siteTokens.title")}
      description={t("siteTokens.description")}
    >
      <SettingsCard>
        <SettingsCardRow className="group">
          <label htmlFor={siteIdField} className="text-sm font-medium">
            {t("siteTokens.siteId")}
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("siteTokens.siteIdDescription")}
          </p>
          <div className="mt-3 flex items-center gap-2">
            {site ? (
              <CopyableField
                id={siteIdField}
                value={site}
                copyLabel={t("siteTokens.copySiteId")}
                copiedLabel={t("siteTokens.siteIdCopied")}
                className="min-w-0 flex-1"
              />
            ) : (
              <p className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
                —
              </p>
            )}
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              disabled={!list.data || issue.isPending}
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
            <div className="flex min-w-0 items-center gap-3">
              <Key01 size={16} className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs">{token.kid}</p>
                <p className="text-xs text-muted-foreground">
                  {t("siteTokens.issuedAgo", {
                    when: formatTimeAgo(new Date(token.iat * 1000)),
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                aria-label={t("siteTokens.revokeLabel", { kid: token.kid })}
                onClick={() => setRevoking(token.kid)}
              >
                <Trash01 size={14} />
              </Button>
            </div>
          </SettingsCardRow>
        ))}
      </SettingsCard>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && !revoke.isPending && setRevoking(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("siteTokens.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("siteTokens.revokeDescription", { kid: revoking ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              {t("siteTokens.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={(event) => {
                // Stay open until the revoke answers.
                event.preventDefault();
                if (revoking) revoke.mutate(revoking);
              }}
            >
              {revoke.isPending ? <Spinner className="size-3.5" /> : null}
              {t("siteTokens.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              aria-label={t("siteTokens.createdTitle")}
              value={created ?? ""}
              className="font-mono text-xs"
            />
            {created ? (
              <CopyValueButton
                value={created}
                label={t("siteTokens.copy")}
                copiedLabel={t("siteTokens.copied")}
                variant="outline"
                size="icon"
                className="shrink-0"
              />
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>
              {t("siteTokens.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
