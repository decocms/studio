/**
 * GitHub Registry Discovery
 *
 * Browse skills and agents from a locally-cloned GitHub repository.
 * Reuses the Store's MCPServerCardGrid for consistent UI.
 */

import { useState } from "react";
import { Loading01, RefreshCw01, Inbox01, SearchMd } from "@untitledui/icons";
import {
  useGitHubRegistry,
  useGitHubRegistrySync,
} from "@/web/hooks/use-github-registry";
import { MCPServerCardGrid } from "./mcp-server-card";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { RegistryItem } from "./types";

interface GitHubRegistryDiscoveryProps {
  owner: string;
  repo: string;
  onItemClick: (item: RegistryItem) => void;
}

type FilterType = "all" | "skills" | "agents";

function filterByType(items: RegistryItem[], type: FilterType): RegistryItem[] {
  if (type === "all") return items;
  return items.filter((item) => {
    const categories =
      item._meta?.["mcp.mesh"]?.categories?.map((c) => c.toLowerCase()) ?? [];
    if (type === "skills") return categories.includes("skills");
    if (type === "agents") return categories.includes("agents");
    return true;
  });
}

function filterBySearch(items: RegistryItem[], search: string): RegistryItem[] {
  if (!search) return items;
  const q = search.toLowerCase();
  return items.filter(
    (item) =>
      (item.name || item.title || "").toLowerCase().includes(q) ||
      (item.description || item.server?.description || "")
        .toLowerCase()
        .includes(q),
  );
}

export function GitHubRegistryDiscovery({
  owner,
  repo,
  onItemClick,
}: GitHubRegistryDiscoveryProps) {
  const { data, isLoading, error } = useGitHubRegistry(owner, repo);
  const syncMutation = useGitHubRegistrySync();
  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");

  const items = data?.items ?? [];
  const filtered = filterBySearch(filterByType(items, filter), search);
  const skills = items.filter((i) =>
    i._meta?.["mcp.mesh"]?.categories?.includes("Skills"),
  );
  const agents = items.filter((i) =>
    i._meta?.["mcp.mesh"]?.categories?.includes("Agents"),
  );

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <Loading01
          size={32}
          className="animate-spin text-muted-foreground mb-4"
        />
        <p className="text-sm text-muted-foreground">
          Loading {owner}/{repo}...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-sm text-muted-foreground">
          Repository not cloned yet. Click Sync to clone{" "}
          <strong>
            {owner}/{repo}
          </strong>
          .
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncMutation.mutate({ owner, repo })}
          disabled={syncMutation.isPending}
        >
          {syncMutation.isPending ? (
            <Loading01 className="size-4 animate-spin" />
          ) : (
            <RefreshCw01 className="size-4" />
          )}
          {syncMutation.isPending ? "Cloning..." : "Sync Repository"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header with search and filter */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <SearchMd className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search skills and agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-input bg-transparent py-2 pl-10 pr-4 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          />
        </div>

        {/* Type filter pills */}
        <div className="flex items-center gap-1 rounded-lg border border-input p-0.5">
          {(
            [
              { value: "all", label: `All (${items.length})` },
              { value: "skills", label: `Skills (${skills.length})` },
              { value: "agents", label: `Agents (${agents.length})` },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilter(opt.value)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                filter === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Sync button */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncMutation.mutate({ owner, repo })}
          disabled={syncMutation.isPending}
          className="h-9"
        >
          <RefreshCw01
            className={cn("size-4", syncMutation.isPending && "animate-spin")}
          />
          Sync
        </Button>
      </div>

      {/* Content */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <Inbox01 className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {search
              ? "No matching items found"
              : `No ${filter === "all" ? "skills or agents" : filter} found in this repository`}
          </p>
        </div>
      ) : (
        <MCPServerCardGrid
          items={filtered}
          title=""
          onItemClick={onItemClick}
        />
      )}
    </div>
  );
}
