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
import { authClient } from "@/web/lib/auth-client";
import { formatDate } from "@/web/lib/format-time";
import { getInitials } from "@/web/lib/get-initials";
import { KEYS } from "@/web/lib/query-keys";

interface DeploymentAdminUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  const { data, isLoading, isError } = useQuery({
    queryKey: KEYS.deploymentAdminUsers(debouncedSearch),
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (debouncedSearch) params.set("searchValue", debouncedSearch);
      const res = await fetch(`/api/_admin/users?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load users");
      return (await res.json()) as {
        users: DeploymentAdminUser[];
        total: number;
      };
    },
  });

  const impersonateMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch("/api/_admin/impersonate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error || "Failed to impersonate user");
      }
    },
    onSuccess: () => {
      // Session just changed under us — full reload, not a client nav.
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to impersonate user",
      );
    },
  });

  const users = data?.users ?? [];

  const columns: TableColumn<DeploymentAdminUser>[] = [
    {
      id: "user",
      header: "User",
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
              {user.name || "Unknown"}
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
      header: "Email",
      render: (user) =>
        user.emailVerified ? (
          <Badge variant="outline" className="text-green-600 border-green-400">
            Verified
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            Unverified
          </Badge>
        ),
      cellClassName: "w-28 shrink-0",
    },
    {
      id: "created",
      header: "Created",
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
          Impersonate
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
              placeholder="Search users by email or name..."
              className="w-full md:w-[375px]"
            />
            <CollectionTableWrapper
              columns={columns}
              data={users}
              isLoading={isLoading}
              emptyState={
                isError ? (
                  <EmptyState
                    title="Failed to load users"
                    description="Something went wrong. Refresh to try again."
                  />
                ) : (
                  <EmptyState
                    title="No users found"
                    description={
                      debouncedSearch
                        ? `No users match "${debouncedSearch}"`
                        : "No users yet."
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
