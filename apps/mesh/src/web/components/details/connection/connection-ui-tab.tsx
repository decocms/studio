import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { MCPAppRenderer } from "@/mcp-apps/mcp-app-renderer.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ToolAnnotationBadges, type Tool } from "@/web/components/tools";
import { Card } from "@deco/ui/components/card.tsx";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useConnection,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { getConnectionSlug } from "@/web/utils/connection-slug";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

interface ConnectionUiTabProps {
  tools: Tool[] | undefined;
  connectionId: string;
  org: string;
}

export function ConnectionUiTab({
  tools,
  connectionId,
  org,
}: ConnectionUiTabProps) {
  const navigate = useNavigate();
  const { org: projectOrg } = useProjectContext();
  const client = useMCPClient({ connectionId, orgId: projectOrg.id });
  const connectionData = useConnection(connectionId);
  const appSlug = connectionData
    ? getConnectionSlug(connectionData)
    : connectionId;
  const [search, setSearch] = useState("");

  // Filter to only tools with a UI resource URI
  const uiTools = (tools ?? []).filter((t) => !!getUIResourceUri(t._meta));

  const searchLower = search.toLowerCase().trim();
  const filteredTools = searchLower
    ? uiTools.filter(
        (t) =>
          t.name.toLowerCase().includes(searchLower) ||
          (t.description && t.description.toLowerCase().includes(searchLower)),
      )
    : uiTools;

  const handleToolClick = (tool: Tool) => {
    navigate({
      to: "/$org/$project/mcps/$appSlug/$collectionName/$itemId",
      params: {
        org,
        project: ORG_ADMIN_PROJECT_SLUG,
        appSlug,
        collectionName: "tools",
        itemId: encodeURIComponent(tool.name),
      },
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <CollectionSearch
        value={search}
        onChange={setSearch}
        placeholder="Search apps..."
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />

      <div className="flex-1 overflow-auto p-5">
        {filteredTools.length === 0 ? (
          <EmptyState
            image={null}
            title={search ? "No apps found" : "No apps available"}
            description={
              search
                ? "Try adjusting your search terms"
                : "This connection doesn't have any tools with interactive UIs yet."
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
            {filteredTools.map((tool) => {
              const resourceUri = getUIResourceUri(tool._meta)!;
              return (
                <Card
                  key={tool.name}
                  className="cursor-pointer transition-colors overflow-hidden gap-0"
                  onClick={() => handleToolClick(tool)}
                >
                  {/* App preview */}
                  <div className="h-[200px] overflow-hidden border-b border-border">
                    <MCPAppRenderer
                      resourceURI={resourceUri}
                      toolInfo={{
                        tool: tool as import("@modelcontextprotocol/sdk/types.js").Tool,
                      }}
                      displayMode="inline"
                      minHeight={200}
                      maxHeight={200}
                      client={client}
                    />
                  </div>

                  {/* Tool info */}
                  <div className="flex flex-col gap-2 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-base font-medium text-foreground truncate">
                        {tool.name}
                      </h3>
                      <ToolAnnotationBadges
                        annotations={tool.annotations}
                        _meta={tool._meta}
                      />
                    </div>
                    {tool.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {tool.description}
                      </p>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
