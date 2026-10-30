import { Suspense, useDeferredValue, useState } from "react";
import { ChevronDown, ChevronRight } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useQuery } from "@tanstack/react-query";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { ToolItem } from "@/components/tool-set-selector.tsx";
import { useT } from "@/i18n/use-t.ts";
import {
  type ConnectionEntity,
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@/sdk";
import { collectionItemQueryOptions } from "@/sdk/hooks/use-collections";
import { countTools, STUDIO_RESOURCE } from "./api-key-access";

interface PickerTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean };
}

function matches(tool: PickerTool, query: string): boolean {
  return (
    tool.name.toLowerCase().includes(query) ||
    (tool.description?.toLowerCase().includes(query) ?? false)
  );
}

function ToolGroup({
  resource,
  title,
  icon,
  tools,
  selected,
  onChange,
  query,
  onExpand,
}: {
  /** Permission resource: `self` or the connection id. */
  resource: string;
  title: string;
  icon: string | null | undefined;
  /** `null` while a connection's tools have not been fetched yet. */
  tools: PickerTool[] | null;
  selected: string[];
  onChange: (selected: string[]) => void;
  query: string;
  /** Expanding is what fetches a connection's tools. */
  onExpand?: () => void;
}) {
  const t = useT();
  const [userExpanded, setUserExpanded] = useState(false);
  const titleMatches = !query || title.toLowerCase().includes(query);
  const visible =
    tools === null
      ? null
      : titleMatches
        ? tools
        : tools.filter((tool) => matches(tool, query));
  const expanded = userExpanded || (!!query && (visible?.length ?? 0) > 0);
  // A search hides groups it can't match: unfetched connections match by name only.
  const hidden = !titleMatches && !visible?.length;
  const selectedSet = new Set(selected);
  const allSelected =
    tools !== null && tools.length > 0 && selected.length >= tools.length;

  const toggleExpanded = () => {
    if (!userExpanded) onExpand?.();
    setUserExpanded(!userExpanded);
  };

  const toggleAll = () => {
    if (selected.length > 0) {
      onChange([]);
      return;
    }
    if (tools === null) {
      // Nothing to select until the tools load; open the group to load them.
      onExpand?.();
      setUserExpanded(true);
      return;
    }
    onChange(tools.map((tool) => tool.name));
  };

  if (hidden) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {/* The checkbox sits outside the toggle button: inside a form, Radix
          re-dispatches a click from its hidden input whenever `checked`
          changes, which would collapse the group on every selection. */}
      <div className="flex items-center gap-3 pr-4 hover:bg-accent">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pl-3 text-left"
        >
          {expanded ? (
            <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={16}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <IntegrationIcon icon={icon} name={title} size="xs" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {title}
          </span>
          {(tools !== null || selected.length > 0) && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {tools === null
                ? selected.length
                : t("settings.apiKeys.toolsGroupCount", {
                    count: selected.length,
                    total: tools.length,
                  })}
            </span>
          )}
        </button>
        <Checkbox
          checked={
            allSelected ? true : selected.length > 0 ? "indeterminate" : false
          }
          onCheckedChange={toggleAll}
          aria-label={t("settings.apiKeys.toolsSelectGroup", { name: title })}
        />
      </div>
      {expanded && (
        <div className="space-y-1 border-t border-border p-1">
          {visible === null ? (
            <div className="flex justify-center py-4">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : visible.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t("settings.apiKeys.toolsNone")}
            </p>
          ) : (
            visible.map((tool) => (
              <ToolItem
                key={tool.name}
                connectionId={resource}
                tool={tool}
                isSelected={selectedSet.has(tool.name)}
                onToggle={() =>
                  onChange(
                    selectedSet.has(tool.name)
                      ? selected.filter((name) => name !== tool.name)
                      : [...selected, tool.name],
                  )
                }
                badge={
                  tool.annotations?.readOnlyHint === true && (
                    <Badge variant="muted" size="sm">
                      {t("settings.apiKeys.readOnlyBadge")}
                    </Badge>
                  )
                }
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionToolGroup({
  connection,
  selected,
  onChange,
  query,
}: {
  connection: ConnectionEntity;
  selected: string[];
  onChange: (selected: string[]) => void;
  query: string;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [requested, setRequested] = useState(false);
  // The list omits tools; GET lists them live, as the role editor does.
  const { data } = useQuery({
    ...collectionItemQueryOptions<ConnectionEntity>(
      org.id,
      "CONNECTIONS",
      connection.id,
      client,
    ),
    enabled: requested,
  });
  const tools = data ? (data.item?.tools ?? []) : null;

  return (
    <ToolGroup
      resource={connection.id}
      title={connection.title}
      icon={connection.icon}
      tools={tools}
      selected={selected}
      onChange={onChange}
      query={query}
      onExpand={() => setRequested(true)}
    />
  );
}

function ConnectionToolGroups({
  toolSet,
  onChange,
  query,
}: {
  toolSet: Record<string, string[]>;
  onChange: (resource: string, tools: string[]) => void;
  query: string;
}) {
  const { org } = useProjectContext();
  const selfId = WellKnownOrgMCPId.SELF(org.id);
  const connections = useConnections().filter((c) => c.id !== selfId);

  return connections.map((connection) => (
    <ConnectionToolGroup
      key={connection.id}
      connection={connection}
      selected={toolSet[connection.id] ?? []}
      onChange={(tools) => onChange(connection.id, tools)}
      query={query}
    />
  ));
}

/** Tools grouped by where they run: Studio itself, then each connection. */
export function ApiKeyToolPicker({
  studioTools,
  toolSet,
  onChange,
}: {
  studioTools: PickerTool[];
  toolSet: Record<string, string[]>;
  onChange: (toolSet: Record<string, string[]>) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const setResource = (resource: string, tools: string[]) =>
    onChange({ ...toolSet, [resource]: tools });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t("settings.apiKeys.toolsSearch")}
          className="flex-1"
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("settings.apiKeys.toolsSelected", { count: countTools(toolSet) })}
        </span>
      </div>
      <div className="max-h-80 space-y-2 overflow-y-auto">
        <ToolGroup
          resource={STUDIO_RESOURCE}
          title={t("settings.apiKeys.studioTools")}
          icon="/favicon.svg"
          tools={studioTools}
          selected={toolSet[STUDIO_RESOURCE] ?? []}
          onChange={(tools) => setResource(STUDIO_RESOURCE, tools)}
          query={query}
        />
        <Suspense
          fallback={
            <div className="flex justify-center py-3">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          }
        >
          <ConnectionToolGroups
            toolSet={toolSet}
            onChange={setResource}
            query={query}
          />
        </Suspense>
      </div>
    </div>
  );
}
