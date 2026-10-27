/**
 * Site tokens of a hosted v8 site: what the site passes as
 * `createCMS({ site, token })` to send telemetry, next to the site id (the
 * only place settings show it; hover the row to copy it). A token is shown
 * once, in a dialog with its copy button; issuing always works, and the list
 * shows every token issued (their key ids, never the tokens).
 */

import { useId, useState } from "react";
import { Key01, Plus } from "@untitledui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
}: {
  orgSlug: string;
  virtualMcpId: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const base = `/api/${orgSlug}/hosted/${encodeURIComponent(virtualMcpId)}/site-tokens`;
  const key = KEYS.hostedSiteTokens(orgSlug, virtualMcpId);
  const [created, setCreated] = useState<string | null>(null);
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
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">{token.kid}</p>
                <p className="text-xs text-muted-foreground">
                  {t("siteTokens.issuedAgo", {
                    when: formatTimeAgo(new Date(token.iat * 1000)),
                  })}
                </p>
              </div>
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
