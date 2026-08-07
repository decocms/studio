import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Page } from "@/components/page";
import { CollectionTableWrapper } from "@/components/collections/collection-table-wrapper.tsx";
import type { TableColumn } from "@/components/collections/collection-table.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@deco/ui/components/dialog.tsx";
import { adminFetch } from "@/lib/admin-fetch";
import { formatDate } from "@/lib/format-time";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

interface BillingOrg {
  id: string;
  name: string;
  slug: string;
  status: string;
  currentPeriodEnd: string | null;
  periodKey: string;
  used: number;
  limit: number;
  /** Per-org overrides; null = deployment default. */
  freeTaskExecutions: number | null;
  monthlyTaskExecutions: number | null;
  totalClaims: number;
}

interface BillingDefaults {
  freeTaskExecutions: number;
  monthlyTaskExecutions: number;
}

/** Empty string = deployment default (sent as null); else a positive int4
 *  (the server enforces the same bounds). `undefined` = invalid input. */
function parseQuotaInput(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : undefined;
}

function EditQuotaDialog({
  org,
  defaults,
}: {
  org: BillingOrg;
  defaults: BillingDefaults;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [free, setFree] = useState(org.freeTaskExecutions?.toString() ?? "");
  const [monthly, setMonthly] = useState(
    org.monthlyTaskExecutions?.toString() ?? "",
  );
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => {
      const freeValue = parseQuotaInput(free);
      const monthlyValue = parseQuotaInput(monthly);
      if (freeValue === undefined || monthlyValue === undefined) {
        return Promise.reject(new Error(t("admin.billing.invalidQuota")));
      }
      return adminFetch(`/api/_admin/billing/orgs/${org.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          freeTaskExecutions: freeValue,
          monthlyTaskExecutions: monthlyValue,
        }),
      });
    },
    onSuccess: () => {
      toast.success(t("admin.billing.quotaUpdated", { org: org.name }));
      queryClient.invalidateQueries({
        queryKey: KEYS.deploymentAdminBillingList(),
      });
      setOpen(false);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.billing.failedUpdateQuota"),
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("admin.billing.editQuota")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("admin.billing.editQuotaFor", { org: org.name })}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="admin-quota-free">
              {t("admin.billing.freeQuotaLabel")}
            </Label>
            <Input
              id="admin-quota-free"
              type="number"
              min={1}
              value={free}
              onChange={(e) => setFree(e.target.value)}
              placeholder={t("admin.billing.default", {
                value: defaults.freeTaskExecutions,
              })}
              disabled={mutation.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-quota-monthly">
              {t("admin.billing.monthlyQuotaLabel")}
            </Label>
            <Input
              id="admin-quota-monthly"
              type="number"
              min={1}
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder={t("admin.billing.default", {
                value: defaults.monthlyTaskExecutions,
              })}
              disabled={mutation.isPending}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {t("admin.billing.blankUsesDefault")}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={mutation.isPending}
          >
            {t("admin.billing.cancel")}
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending
              ? t("admin.billing.saving")
              : t("admin.billing.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminBillingPage() {
  const t = useT();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const { data, isLoading, isError } = useQuery({
    queryKey: KEYS.deploymentAdminBilling(debouncedSearch),
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (debouncedSearch) params.set("search", debouncedSearch);
      return adminFetch<{
        defaults: BillingDefaults;
        organizations: BillingOrg[];
      }>(`/api/_admin/billing/orgs?${params}`);
    },
  });

  const orgs = data?.organizations ?? [];
  const defaults = data?.defaults ?? {
    freeTaskExecutions: 0,
    monthlyTaskExecutions: 0,
  };

  const quotaCell = (override: number | null, defaultValue: number) =>
    override != null ? (
      <span className="text-sm font-medium text-foreground">{override}</span>
    ) : (
      <span className="text-sm text-muted-foreground">
        {t("admin.billing.default", { value: defaultValue })}
      </span>
    );

  const columns: TableColumn<BillingOrg>[] = [
    {
      id: "name",
      header: t("admin.billing.organization"),
      render: (org) => (
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">
            {org.name}
          </div>
          <div className="text-sm text-muted-foreground truncate">
            {org.slug}
          </div>
        </div>
      ),
      cellClassName: "flex-1 min-w-0",
    },
    {
      id: "plan",
      header: t("admin.billing.plan"),
      render: (org) => (
        <span className="text-sm text-foreground capitalize">
          {org.status === "none" ? t("admin.billing.planFree") : org.status}
        </span>
      ),
      cellClassName: "w-24 shrink-0",
    },
    {
      id: "usage",
      header: t("admin.billing.usage"),
      render: (org) => (
        <div>
          <div className="text-sm text-foreground">
            {org.used} / {org.limit}
          </div>
          <div className="text-sm text-muted-foreground">
            {org.periodKey === "trial"
              ? t("admin.billing.trial")
              : org.currentPeriodEnd
                ? t("admin.billing.renews", {
                    date: formatDate(org.currentPeriodEnd),
                  })
                : t("admin.billing.pendingCycle")}
          </div>
        </div>
      ),
      cellClassName: "w-40 shrink-0",
    },
    {
      id: "totalClaims",
      header: t("admin.billing.allTimeClaims"),
      render: (org) => (
        <span className="text-sm text-foreground">{org.totalClaims}</span>
      ),
      cellClassName: "w-32 shrink-0",
    },
    {
      id: "freeQuota",
      header: t("admin.billing.freeQuota"),
      render: (org) =>
        quotaCell(org.freeTaskExecutions, defaults.freeTaskExecutions),
      cellClassName: "w-28 shrink-0",
    },
    {
      id: "monthlyQuota",
      header: t("admin.billing.monthlyQuota"),
      render: (org) =>
        quotaCell(org.monthlyTaskExecutions, defaults.monthlyTaskExecutions),
      cellClassName: "w-28 shrink-0",
    },
    {
      id: "actions",
      header: "",
      render: (org) => (
        // Key remounts the dialog when fresh data lands, so its inputs re-seed
        // from the row instead of keeping pre-save state.
        <EditQuotaDialog
          key={`${org.id}-${org.freeTaskExecutions}-${org.monthlyTaskExecutions}`}
          org={org}
          defaults={defaults}
        />
      ),
      cellClassName: "w-28 shrink-0",
    },
  ];

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("admin.billing.searchPlaceholder")}
              className="w-full md:w-[375px]"
            />
            <CollectionTableWrapper
              columns={columns}
              data={orgs}
              isLoading={isLoading}
              emptyState={
                isError ? (
                  <EmptyState
                    title={t("admin.billing.failedLoad")}
                    description={t("admin.billing.failedLoadDescription")}
                  />
                ) : (
                  <EmptyState
                    title={t("admin.billing.noOrgsFound")}
                    description={
                      debouncedSearch
                        ? t("admin.billing.noOrgsMatchSearch", {
                            search: debouncedSearch,
                          })
                        : t("admin.billing.noOrgsYet")
                    }
                  />
                )
              }
            />
          </div>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
