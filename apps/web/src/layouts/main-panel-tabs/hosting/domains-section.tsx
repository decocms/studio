/**
 * Custom domains. The control-plane hides which substrate wires a hostname
 * (knative DecoDomain vs a CF Worker route); Studio shows whether it is live,
 * provisioning, or waiting on the operator, and the exact DNS to add.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe01, Plus, Trash01 } from "@untitledui/icons";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { errorText, mutateJson, type DnsRecord, type Domain } from "./api";
import { DomainDnsPanel } from "./dns-panel";
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

function DomainStatusBadge({ domain }: { domain: Domain }) {
  const t = useT();
  const status = domain.status ?? "pending";
  const label =
    status === "active"
      ? t("mainPanelTabs.hostingTab.statusActive")
      : status === "action-required"
        ? t("mainPanelTabs.hostingTab.statusActionRequired")
        : t("mainPanelTabs.hostingTab.statusPending");
  const detail =
    domain.detail === "zone-not-onboarded"
      ? t("mainPanelTabs.hostingTab.detailZoneNotOnboarded")
      : undefined;
  const badge = (
    <Badge
      variant={
        status === "active"
          ? "success"
          : status === "action-required"
            ? "warning"
            : "outline"
      }
    >
      {label}
    </Badge>
  );
  if (!detail) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{detail}</TooltipContent>
    </Tooltip>
  );
}

export function DomainsSection({
  base,
  orgSlug,
  site,
  domains,
  dnsTemplate,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  domains: Domain[];
  dnsTemplate: DnsRecord[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formHost, setFormHost] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [dnsOpenHost, setDnsOpenHost] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.hostingDomains(orgSlug, site),
    });

  const putMutation = useMutation({
    mutationFn: (input: { host: string }) =>
      mutateJson(`${base}/domains`, "PUT", input),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastDomainSaved"));
      setDialogOpen(false);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (host: string) =>
      mutateJson(`${base}/domains/${encodeURIComponent(host)}`, "DELETE"),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastDomainDeleted"));
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const handleSave = () => {
    const host = formHost.trim().toLowerCase();
    if (!host) {
      toast.error(t("mainPanelTabs.hostingTab.errorDomainHostRequired"));
      return;
    }
    putMutation.mutate({ host });
  };

  // The attach-form DNS preview: the site's substrate-correct template with the
  // record name swapped to the host the operator is typing.
  const previewRecords = dnsTemplate.map((r) => ({
    ...r,
    name: formHost.trim().toLowerCase() || r.name,
  }));

  const addButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        setFormHost("");
        setDialogOpen(true);
      }}
    >
      <Plus />
      {t("mainPanelTabs.hostingTab.addDomain")}
    </Button>
  );

  return (
    <HostingSection
      title={t("mainPanelTabs.hostingTab.domains")}
      actions={domains.length > 0 ? addButton : undefined}
    >
      {isLoading ? (
        <RowsSkeleton />
      ) : error ? (
        <ListCard>
          <ListMessage>
            {t("mainPanelTabs.hostingTab.domainsError")}
          </ListMessage>
        </ListCard>
      ) : domains.length === 0 ? (
        <ListCard>
          <EmptyState
            icon={<Globe01 className="size-5" />}
            title={t("mainPanelTabs.hostingTab.noDomains")}
            className="py-10"
            buttonComponent={addButton}
          />
        </ListCard>
      ) : (
        <ListCard>
          {domains.map((d, i) => {
            const hasDns = !d.canonical && (d.dns?.length ?? 0) > 0;
            const open = dnsOpenHost === d.host;
            return (
              <div key={`${d.host}-${i}`}>
                <ListRow>
                  {hasDns ? (
                    <ExpandChevron
                      open={open}
                      onClick={() => setDnsOpenHost(open ? null : d.host)}
                    />
                  ) : (
                    <Globe01 className="size-4 shrink-0 text-muted-foreground/60" />
                  )}
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate font-mono text-xs">{d.host}</span>
                    {d.canonical && (
                      <Badge variant="outline">
                        {t("mainPanelTabs.hostingTab.canonical")}
                      </Badge>
                    )}
                  </div>
                  <DomainStatusBadge domain={d} />
                  {!d.canonical && (
                    <IconButton
                      label={t("mainPanelTabs.hostingTab.deleteDomain")}
                      onClick={() => setDeleteTarget(d.host)}
                      disabled={deleteMutation.isPending}
                      className="text-muted-foreground"
                    >
                      <Trash01 />
                    </IconButton>
                  )}
                </ListRow>
                {hasDns && (
                  <RowDetails open={open}>
                    <DomainDnsPanel records={d.dns ?? []} />
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
              {t("mainPanelTabs.hostingTab.addDomainTitle")}
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
              <Label htmlFor="domain-host">
                {t("mainPanelTabs.hostingTab.colHost")}
              </Label>
              <Input
                id="domain-host"
                placeholder={t(
                  "mainPanelTabs.hostingTab.domainHostPlaceholder",
                )}
                value={formHost}
                onChange={(e) => setFormHost(e.target.value)}
                className="font-mono text-xs"
                autoComplete="off"
                disabled={putMutation.isPending}
              />
            </div>
            {formHost.trim() && (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <DomainDnsPanel records={previewRecords} />
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
                disabled={putMutation.isPending || !formHost.trim()}
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
        title={t("mainPanelTabs.hostingTab.confirmDeleteDomainTitle")}
        description={t(
          "mainPanelTabs.hostingTab.confirmDeleteDomainDescription",
          { host: deleteTarget ?? "" },
        )}
        confirmLabel={t("mainPanelTabs.hostingTab.deleteDomain")}
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget);
        }}
      />
    </HostingSection>
  );
}
