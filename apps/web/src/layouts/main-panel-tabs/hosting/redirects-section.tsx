/**
 * Redirects. PUT is idempotent per `from`: it upserts the redirect for that
 * source, so the same call powers add and edit, and `from` is the identity
 * an edit cannot change.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CornerUpRight,
  Pencil01,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { toast } from "sonner";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { errorText, mutateJson, type Redirect } from "./api";
import { isHostRedirect, RedirectDnsPanel } from "./dns-panel";
import {
  ConfirmDeleteDialog,
  ExpandChevron,
  HostingSection,
  ListCard,
  ListMessage,
  ListRow,
  RowDetails,
  RowsSkeleton,
} from "./shell";

type RedirectType = "permanent" | "temporary";

function RedirectTypeBadge({ type }: { type?: string }) {
  const t = useT();
  return (
    <Badge variant={type === "permanent" ? "secondary" : "outline"}>
      {type === "permanent"
        ? t("mainPanelTabs.hostingTab.permanent")
        : t("mainPanelTabs.hostingTab.temporary")}
    </Badge>
  );
}

export function RedirectsSection({
  base,
  orgSlug,
  site,
  redirects,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  redirects: Redirect[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  // null = add mode; a string = editing that (immutable) `from`.
  const [editingFrom, setEditingFrom] = useState<string | null>(null);
  const [formFrom, setFormFrom] = useState("");
  const [formTo, setFormTo] = useState("");
  const [formType, setFormType] = useState<RedirectType>("permanent");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [dnsOpenFrom, setDnsOpenFrom] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.hostingRedirects(orgSlug, site),
    });

  const putMutation = useMutation({
    mutationFn: (input: { from: string; to: string; type: RedirectType }) =>
      mutateJson(`${base}/redirects`, "PUT", input),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastRedirectSaved"));
      setDialogOpen(false);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (from: string) =>
      mutateJson(`${base}/redirects/${encodeURIComponent(from)}`, "DELETE"),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastRedirectDeleted"));
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const openAdd = () => {
    setEditingFrom(null);
    setFormFrom("");
    setFormTo("");
    setFormType("permanent");
    setDialogOpen(true);
  };

  const openEdit = (r: Redirect) => {
    setEditingFrom(r.from);
    setFormFrom(r.from);
    setFormTo(r.to);
    setFormType(r.type === "temporary" ? "temporary" : "permanent");
    setDialogOpen(true);
  };

  const handleSave = () => {
    const from = formFrom.trim();
    const to = formTo.trim();
    if (!from || !to) {
      toast.error(t("mainPanelTabs.hostingTab.errorRedirectFieldsRequired"));
      return;
    }
    putMutation.mutate({ from, to, type: formType });
  };

  const addButton = (
    <Button size="sm" variant="outline" onClick={openAdd}>
      <Plus />
      {t("mainPanelTabs.hostingTab.addRedirect")}
    </Button>
  );

  return (
    <HostingSection
      title={t("mainPanelTabs.hostingTab.redirects")}
      actions={redirects.length > 0 ? addButton : undefined}
    >
      {isLoading ? (
        <RowsSkeleton />
      ) : error ? (
        <ListCard>
          <ListMessage>
            {t("mainPanelTabs.hostingTab.redirectsError")}
          </ListMessage>
        </ListCard>
      ) : redirects.length === 0 ? (
        <ListCard>
          <EmptyState
            icon={<CornerUpRight className="size-5" />}
            title={t("mainPanelTabs.hostingTab.noRedirects")}
            className="py-10"
            buttonComponent={addButton}
          />
        </ListCard>
      ) : (
        <ListCard>
          {redirects.map((r, i) => {
            const needsDns = isHostRedirect(r.from);
            const open = dnsOpenFrom === r.from;
            return (
              <div key={r.id ?? `${r.from}-${i}`}>
                <ListRow>
                  {needsDns ? (
                    <ExpandChevron
                      open={open}
                      onClick={() => setDnsOpenFrom(open ? null : r.from)}
                    />
                  ) : (
                    <CornerUpRight className="size-4 shrink-0 text-muted-foreground/60" />
                  )}
                  <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-xs">
                    <span className="truncate">{r.from}</span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                    <span className="truncate text-muted-foreground">
                      {r.to}
                    </span>
                  </div>
                  <RedirectTypeBadge type={r.type} />
                  <IconButton
                    label={t("mainPanelTabs.hostingTab.editRedirect")}
                    onClick={() => openEdit(r)}
                    disabled={putMutation.isPending}
                    className="text-muted-foreground"
                  >
                    <Pencil01 />
                  </IconButton>
                  <IconButton
                    label={t("mainPanelTabs.hostingTab.deleteRedirect")}
                    onClick={() => setDeleteTarget(r.from)}
                    disabled={deleteMutation.isPending}
                    className="-ml-1 text-muted-foreground"
                  >
                    <Trash01 />
                  </IconButton>
                </ListRow>
                {needsDns && (
                  <RowDetails open={open}>
                    <RedirectDnsPanel from={r.from} source={r.source} />
                  </RowDetails>
                )}
              </div>
            );
          })}
        </ListCard>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingFrom != null
                ? t("mainPanelTabs.hostingTab.editRedirectTitle")
                : t("mainPanelTabs.hostingTab.addRedirectTitle")}
            </DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="redirect-from">
                {t("mainPanelTabs.hostingTab.colFrom")}
              </Label>
              <Input
                id="redirect-from"
                placeholder={t(
                  "mainPanelTabs.hostingTab.redirectFromPlaceholder",
                )}
                value={formFrom}
                onChange={(e) => setFormFrom(e.target.value)}
                className="font-mono text-xs"
                disabled={editingFrom != null || putMutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="redirect-to">
                {t("mainPanelTabs.hostingTab.colTo")}
              </Label>
              <Input
                id="redirect-to"
                placeholder={t(
                  "mainPanelTabs.hostingTab.redirectToPlaceholder",
                )}
                value={formTo}
                onChange={(e) => setFormTo(e.target.value)}
                className="font-mono text-xs"
                disabled={putMutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("mainPanelTabs.hostingTab.colType")}</Label>
              <Select
                value={formType}
                onValueChange={(v) =>
                  setFormType(v === "temporary" ? "temporary" : "permanent")
                }
                disabled={putMutation.isPending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="permanent">
                    {t("mainPanelTabs.hostingTab.permanent")}
                  </SelectItem>
                  <SelectItem value="temporary">
                    {t("mainPanelTabs.hostingTab.temporary")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {isHostRedirect(formFrom) && (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <RedirectDnsPanel
                  from={formFrom}
                  source={redirects.find((r) => r.from === editingFrom)?.source}
                />
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setDialogOpen(false)}
                disabled={putMutation.isPending}
              >
                {t("mainPanelTabs.hostingTab.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  putMutation.isPending || !formFrom.trim() || !formTo.trim()
                }
              >
                {putMutation.isPending
                  ? t("mainPanelTabs.hostingTab.saving")
                  : t("mainPanelTabs.hostingTab.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("mainPanelTabs.hostingTab.confirmDeleteRedirectTitle")}
        description={t(
          "mainPanelTabs.hostingTab.confirmDeleteRedirectDescription",
          { from: deleteTarget ?? "" },
        )}
        confirmLabel={t("mainPanelTabs.hostingTab.deleteRedirect")}
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget);
        }}
      />
    </HostingSection>
  );
}
