import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { ORG_ADMIN_PROJECT_SLUG, useConnection } from "@decocms/mesh-sdk";
import { getConnectionSlug } from "@/web/utils/connection-slug";
import { BookOpen01, Columns01, ChevronRight, Tool01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import type { Tool as UiTool } from "@/web/components/tools";
import { ConnectionUiTab } from "./connection-ui-tab.tsx";

/**
 * Converts a snake_case or dot.case tool function name to readable English.
 * e.g. "repos.list" -> "List Repos", "create_issue" -> "Create Issue"
 */
function humanizeName(name: string): string {
  const parts = name.replace(/[._]/g, " ").trim().split(/\s+/);
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const verbs = new Set([
    "list",
    "create",
    "get",
    "update",
    "delete",
    "fetch",
    "search",
    "run",
    "trigger",
    "review",
    "send",
    "check",
  ]);

  const words = parts.map(capitalize);
  // If last word is a verb, move it to front for natural reading
  const lastWord = parts[parts.length - 1];
  if (words.length >= 2 && lastWord && verbs.has(lastWord)) {
    const verb = words.pop()!;
    return [verb, ...words].join(" ");
  }
  return words.join(" ");
}

interface Tool {
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
  annotations?: unknown;
}

interface Prompt {
  name: string;
  description?: string;
}

interface Resource {
  name: string;
  description?: string;
  uri?: string;
}

interface ConnectionCapabilitiesProps {
  tools: Tool[];
  prompts?: Prompt[];
  resources?: Resource[];
  connectionId?: string;
  org?: string;
}

function EmptyCapabilities({ label }: { label: string }) {
  return (
    <div className="px-5 py-8 text-center">
      <p className="text-sm text-muted-foreground">No {label} available.</p>
    </div>
  );
}

export function ConnectionCapabilities({
  tools,
  prompts = [],
  resources = [],
  connectionId,
  org,
}: ConnectionCapabilitiesProps) {
  const navigate = useNavigate();
  const connectionData = useConnection(connectionId ?? "");
  const appSlug = connectionData
    ? getConnectionSlug(connectionData)
    : connectionId;

  function openTool(toolName: string) {
    if (!connectionId || !org) return;
    navigate({
      to: "/$org/$project/mcps/$appSlug/$collectionName/$itemId",
      params: {
        org,
        project: ORG_ADMIN_PROJECT_SLUG,
        appSlug: appSlug!,
        collectionName: "tools",
        itemId: encodeURIComponent(toolName),
      },
    });
  }
  const hasUiTools =
    connectionId && org && tools.some((t) => getUIResourceUri(t._meta));

  const totalItems = tools.length + prompts.length + resources.length;

  if (totalItems === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground mb-1">
          Capabilities
        </h3>
        <p className="text-sm text-muted-foreground">
          No capabilities discovered yet. The connection may still be
          connecting.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <Tabs defaultValue="tools" variant="underline">
        <div className="px-5 flex items-center justify-between border-b border-border">
          <TabsList variant="underline" className="gap-1">
            <TabsTrigger value="tools" variant="underline">
              Tools ({tools.length})
            </TabsTrigger>
            {hasUiTools && (
              <TabsTrigger value="apps" variant="underline">
                UI
              </TabsTrigger>
            )}
            <TabsTrigger value="prompts" variant="underline">
              Prompts
            </TabsTrigger>
            <TabsTrigger value="resources" variant="underline">
              Resources
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="tools" className="h-auto">
          <div className="divide-y divide-border">
            {tools.length > 0 ? (
              tools.map((tool) => (
                <button
                  key={tool.name}
                  type="button"
                  className="w-full flex items-start gap-3 px-5 py-3 text-left hover:bg-muted/40 transition-colors cursor-pointer"
                  onClick={() => openTool(tool.name)}
                >
                  <div className="mt-0.5 shrink-0 size-7 rounded-md bg-muted flex items-center justify-center">
                    <Tool01 size={13} className="text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {humanizeName(tool.name)}
                    </div>
                    {tool.description && (
                      <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                        {tool.description}
                      </div>
                    )}
                  </div>
                  <ChevronRight
                    size={16}
                    className="text-muted-foreground shrink-0 mt-0.5"
                  />
                </button>
              ))
            ) : (
              <EmptyCapabilities label="tools" />
            )}
          </div>
        </TabsContent>

        {hasUiTools && (
          <TabsContent value="apps" className="h-auto min-h-[200px]">
            <ConnectionUiTab
              tools={tools as UiTool[]}
              connectionId={connectionId!}
              org={org!}
            />
          </TabsContent>
        )}

        <TabsContent value="prompts" className="h-auto">
          <div className="divide-y divide-border">
            {prompts.length > 0 ? (
              prompts.map((prompt) => (
                <div
                  key={prompt.name}
                  className="flex items-start gap-3 px-5 py-3"
                >
                  <div className="mt-0.5 shrink-0 size-7 rounded-md bg-muted flex items-center justify-center">
                    <BookOpen01 size={13} className="text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {humanizeName(prompt.name)}
                    </div>
                    {prompt.description && (
                      <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                        {prompt.description}
                      </div>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <EmptyCapabilities label="prompts" />
            )}
          </div>
        </TabsContent>

        <TabsContent value="resources" className="h-auto">
          <div className="divide-y divide-border">
            {resources.length > 0 ? (
              resources.map((resource) => (
                <div
                  key={resource.uri ?? resource.name}
                  className="flex items-start gap-3 px-5 py-3"
                >
                  <div className="mt-0.5 shrink-0 size-7 rounded-md bg-muted flex items-center justify-center">
                    <Columns01 size={13} className="text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {resource.name}
                    </div>
                    {resource.description && (
                      <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                        {resource.description}
                      </div>
                    )}
                    {resource.uri && (
                      <div className="text-xs text-muted-foreground/60 font-mono mt-0.5 truncate">
                        {resource.uri}
                      </div>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <EmptyCapabilities label="resources" />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
