import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { McpAvatar } from "./mcp-avatar";

type ThreadResult = {
  type: "thread";
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  virtual_mcp_id: string | null;
  run_config: Record<string, unknown> | null;
  status: string | null;
};

type SearchResult = ThreadResult;

type SearchResponse = {
  items: SearchResult[];
  totalCount: number;
};

export function GlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const { org } = useProjectContext();
  const { setTaskId } = usePanelActions();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const trimmed = query.trim();

  const { data, isFetching } = useQuery({
    queryKey: KEYS.globalSearch(org.id, trimmed),
    enabled: open && trimmed.length > 0,
    queryFn: async (): Promise<SearchResponse> => {
      if (!client) throw new Error("MCP client unavailable");
      const result = (await client.callTool({
        name: "GLOBAL_SEARCH",
        arguments: { query: trimmed, limit: 20 },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as SearchResponse;
    },
    staleTime: 10_000,
  });

  const items = data?.items ?? [];

  const handleOpenChange = (next: boolean) => {
    if (!next) setQuery("");
    onOpenChange(next);
  };

  const handleThreadSelect = (t: ThreadResult) => {
    handleOpenChange(false);
    // Use setTaskId so navigation preserves the current panel layout
    // (`chat`, `tasks`, `main`) — same helper the tasks-panel row click
    // path uses. A direct `navigate({ search: {...} })` would replace the
    // search params and reset the layout.
    setTaskId(t.id, t.virtual_mcp_id ?? undefined);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="overflow-hidden p-0"
        closeButtonClassName="hidden"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>
            Search across your organization's resources.
          </DialogDescription>
        </DialogHeader>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search..."
          />
          <CommandList>
            {!trimmed ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Start typing to search.
              </div>
            ) : isFetching && items.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Searching…
              </div>
            ) : items.length === 0 ? (
              <CommandEmpty>No results.</CommandEmpty>
            ) : (
              items.map((item) => {
                if (item.type === "thread") {
                  return (
                    <CommandItem
                      key={`thread:${item.id}`}
                      value={`thread:${item.id}:${item.title}`}
                      onSelect={() => handleThreadSelect(item)}
                      className="gap-2.5"
                    >
                      <McpAvatar virtualMcpId={item.virtual_mcp_id} size="xs" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-foreground truncate">
                          {item.title || "Untitled thread"}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {new Date(item.updated_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </CommandItem>
                  );
                }
                return null;
              })
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
