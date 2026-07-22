import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Page } from "@/web/components/page";
import { CollectionTableWrapper } from "@/web/components/collections/collection-table-wrapper.tsx";
import type { TableColumn } from "@/web/components/collections/collection-table.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useDebouncedValue } from "@/web/hooks/use-debounced-value";
import { adminFetch } from "@/web/lib/admin-fetch";
import { authClient } from "@/web/lib/auth-client";
import { formatDate } from "@/web/lib/format-time";
import { getInitials } from "@/web/lib/get-initials";
import { KEYS } from "@/web/lib/query-keys";
import { useT } from "@/web/i18n/use-t.ts";

interface DeploymentAdminUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export default function AdminUsersPage() {
  const t = useT();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  const { data, isLoading, isError } = useQuery({
    queryKey: KEYS.deploymentAdminUsers(debouncedSearch),
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (debouncedSearch) params.set("searchValue", debouncedSearch);
      return adminFetch<{ users: DeploymentAdminUser[] }>(
        `/api/_admin/users?${params}`,
      );
    },
  });

  const impersonateMutation = useMutation({
    mutationFn: (userId: string) =>
      adminFetch("/api/_admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      }),
    onSuccess: () => {
      // Session just changed under us — full reload, not a client nav.
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.users.failedToImpersonate"),
      );
    },
  });

  const users = data?.users ?? [];

  const columns: TableColumn<DeploymentAdminUser>[] = [
    {
      id: "user",
      header: t("admin.users.columnUser"),
      render: (user) => (
        <div className="flex items-center gap-3">
          <Avatar
            url={user.image ?? undefined}
            fallback={getInitials(user.name)}
            shape="circle"
            size="sm"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground truncate">
              {user.name || t("admin.users.unknown")}
            </div>
            <div className="text-sm text-muted-foreground truncate">
              {user.email}
            </div>
          </div>
        </div>
      ),
      cellClassName: "flex-1 min-w-0",
    },
    {
      id: "verified",
      header: t("admin.users.columnEmail"),
      render: (user) =>
        user.emailVerified ? (
          <Badge variant="outline" className="text-success border-success/20">
            {t("admin.users.verified")}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            {t("admin.users.unverified")}
          </Badge>
        ),
      cellClassName: "w-28 shrink-0",
    },
    {
      id: "created",
      header: t("admin.users.columnCreated"),
      render: (user) => (
        <span className="text-sm text-foreground">
          {formatDate(user.createdAt)}
        </span>
      ),
      cellClassName: "w-48 shrink-0",
    },
    {
      id: "actions",
      header: "",
      render: (user) => (
        <Button
          variant="outline"
          size="sm"
          disabled={user.id === currentUserId || impersonateMutation.isPending}
          onClick={() => impersonateMutation.mutate(user.id)}
        >
          {t("admin.users.impersonate")}
        </Button>
      ),
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
              placeholder={t("admin.users.searchPlaceholder")}
              className="w-full md:w-[375px]"
            />
            <CollectionTableWrapper
              columns={columns}
              data={users}
              isLoading={isLoading}
              emptyState={
                isError ? (
                  <EmptyState
                    title={t("admin.users.failedToLoadTitle")}
                    description={t("admin.users.failedToLoadDescription")}
                  />
                ) : (
                  <EmptyState
                    title={t("admin.users.noUsersFoundTitle")}
                    description={
                      debouncedSearch
                        ? t("admin.users.noUsersMatchSearch", {
                            search: debouncedSearch,
                          })
                        : t("admin.users.noUsersYet")
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
