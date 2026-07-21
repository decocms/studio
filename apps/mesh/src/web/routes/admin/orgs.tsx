import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Page } from "@/web/components/page";
import { CollectionTableWrapper } from "@/web/components/collections/collection-table-wrapper.tsx";
import type { TableColumn } from "@/web/components/collections/collection-table.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { useDebouncedValue } from "@/web/hooks/use-debounced-value";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@deco/ui/components/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { BUILTIN_ROLES } from "@/auth/roles";
import { adminFetch } from "@/web/lib/admin-fetch";
import { formatDate } from "@/web/lib/format-time";
import { KEYS } from "@/web/lib/query-keys";
import { useT } from "@/web/i18n/use-t.ts";

interface DeploymentAdminOrg {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
}

function AddMemberDialog({ org }: { org: DeploymentAdminOrg }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("user");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      adminFetch(`/api/_admin/orgs/${org.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      }),
    onSuccess: () => {
      toast.success(
        t("admin.orgs.memberAdded", { email: email.trim(), org: org.name }),
      );
      queryClient.invalidateQueries({
        queryKey: KEYS.deploymentAdminOrgsList(),
      });
      setOpen(false);
      setEmail("");
      setRole("user");
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.orgs.failedAddMember"),
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("admin.orgs.addMember")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("admin.orgs.addMemberTo", { org: org.name })}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="admin-add-member-email">
              {t("admin.orgs.email")}
            </Label>
            <Input
              id="admin-add-member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("admin.orgs.emailPlaceholder")}
              disabled={mutation.isPending}
            />
          </div>
          <Select
            value={role}
            onValueChange={setRole}
            disabled={mutation.isPending}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUILTIN_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  <span className="capitalize">{r}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={mutation.isPending}
          >
            {t("admin.orgs.cancel")}
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!email.trim() || mutation.isPending}
          >
            {mutation.isPending
              ? t("admin.orgs.adding")
              : t("admin.orgs.addMember")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminOrgsPage() {
  const t = useT();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const { data, isLoading, isError } = useQuery({
    queryKey: KEYS.deploymentAdminOrgs(debouncedSearch),
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (debouncedSearch) params.set("search", debouncedSearch);
      return adminFetch<{ organizations: DeploymentAdminOrg[] }>(
        `/api/_admin/orgs?${params}`,
      );
    },
  });

  const orgs = data?.organizations ?? [];

  const columns: TableColumn<DeploymentAdminOrg>[] = [
    {
      id: "name",
      header: t("admin.orgs.organization"),
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
      id: "members",
      header: t("admin.orgs.members"),
      render: (org) => (
        <span className="text-sm text-foreground">{org.memberCount}</span>
      ),
      cellClassName: "w-24 shrink-0",
    },
    {
      id: "created",
      header: t("admin.orgs.created"),
      render: (org) => (
        <span className="text-sm text-foreground">
          {formatDate(org.createdAt)}
        </span>
      ),
      cellClassName: "w-48 shrink-0",
    },
    {
      id: "actions",
      header: "",
      render: (org) => <AddMemberDialog org={org} />,
      cellClassName: "w-32 shrink-0",
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
              placeholder={t("admin.orgs.searchPlaceholder")}
              className="w-full md:w-[375px]"
            />
            <CollectionTableWrapper
              columns={columns}
              data={orgs}
              isLoading={isLoading}
              emptyState={
                isError ? (
                  <EmptyState
                    title={t("admin.orgs.failedLoadOrgs")}
                    description={t("admin.orgs.failedLoadOrgsDescription")}
                  />
                ) : (
                  <EmptyState
                    title={t("admin.orgs.noOrgsFound")}
                    description={
                      debouncedSearch
                        ? t("admin.orgs.noOrgsMatchSearch", {
                            search: debouncedSearch,
                          })
                        : t("admin.orgs.noOrgsYet")
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
