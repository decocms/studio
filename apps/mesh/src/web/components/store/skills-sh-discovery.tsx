/**
 * skills.sh Discovery
 *
 * Search-driven discovery for skills from skills.sh.
 * API requires minimum 2 characters for search.
 */

import { useState } from "react";
import { Loading01, SearchMd, Inbox01 } from "@untitledui/icons";
import { useSkillsShSearch } from "@/web/hooks/use-skills-sh";
import { useDebounce } from "@/web/hooks/use-debounce";
import { MCPServerCardGrid } from "./mcp-server-card";
import type { RegistryItem } from "./types";

interface SkillsShDiscoveryProps {
  onItemClick: (item: RegistryItem) => void;
}

export function SkillsShDiscovery({ onItemClick }: SkillsShDiscoveryProps) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const { data: items, isLoading } = useSkillsShSearch(debouncedSearch);

  return (
    <div className="flex flex-col gap-6">
      {/* Prominent search */}
      <div className="flex flex-col items-center gap-3 pt-4">
        <div className="text-center space-y-1">
          <h2 className="text-lg font-medium">skills.sh</h2>
          <p className="text-sm text-muted-foreground">
            Search 88K+ community skills for AI agents
          </p>
        </div>
        <div className="relative w-full max-w-lg">
          <SearchMd className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search skills (e.g. react, typescript, nextjs)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-input bg-transparent py-2.5 pl-10 pr-4 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
        </div>
      </div>

      {/* Results */}
      {isLoading && debouncedSearch.length >= 2 ? (
        <div className="flex flex-col items-center justify-center py-12">
          <Loading01
            size={24}
            className="animate-spin text-muted-foreground mb-2"
          />
          <p className="text-sm text-muted-foreground">Searching...</p>
        </div>
      ) : debouncedSearch.length < 2 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <SearchMd className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Type at least 2 characters to search
          </p>
        </div>
      ) : items && items.length > 0 ? (
        <MCPServerCardGrid
          items={items}
          title={`${items.length} results`}
          onItemClick={onItemClick}
        />
      ) : (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <Inbox01 className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No skills found for &ldquo;{debouncedSearch}&rdquo;
          </p>
        </div>
      )}
    </div>
  );
}
