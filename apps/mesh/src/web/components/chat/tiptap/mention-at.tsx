/**
 * Two-level @ mention: first shows categories (Resources, Agents),
 * then drills into items when a category is selected.
 */

import { KEYS } from "@/web/lib/query-keys";
import {
  isDecopilot,
  listResources,
  readResource,
  useMCPClient,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { ListResourcesResult } from "@modelcontextprotocol/sdk/types.js";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { BaseItem, insertMention, OnSelectProps, Suggestion } from "./mention";
import { track } from "@/web/lib/posthog-client";

interface AtMentionProps {
  editor: Editor;
  virtualMcpId: string | null;
}

type AtMode = "categories" | "agents" | "resources";

interface AtItem extends BaseItem {
  /** Discriminator for item type */
  kind: "category" | "agent" | "resource";
  /** Agent ID (for agents) */
  agentId?: string;
  /** Resource URI (for resources) */
  uri?: string;
}

const CATEGORY_ITEMS: AtItem[] = [
  {
    name: "agents",
    title: "Agents",
    description: "Mention an agent to hand off work",
    kind: "category",
    drillable: true,
  },
  {
    name: "resources",
    title: "Resources",
    description: "Attach a resource as context",
    kind: "category",
    drillable: true,
  },
];

export const AtMention = ({ editor, virtualMcpId }: AtMentionProps) => {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const agents = useVirtualMCPs();
  const client = useMCPClient({
    connectionId: virtualMcpId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const resourcesQueryKey = KEYS.virtualMcpResources(virtualMcpId, org.id);

  const [mode, setMode] = useState<AtMode>("categories");
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Track picker open → close outcome so we can measure abandonment.
  const pickerOpenedAtRef = useRef<number | null>(null);
  const pickerHadSelectionRef = useRef(false);

  // Reset mode when menu closes/opens (query key changes signal re-render)
  const queryKey = ["at-mention", org.id, virtualMcpId ?? "default", mode];

  const handleItemSelect = async ({
    item,
    range,
  }: OnSelectProps<AtItem>): Promise<void | false> => {
    track("chat_picker_item_selected", {
      picker: "@",
      item_kind: item.kind,
      item_name: item.name,
    });
    // Category clicks drill deeper — don't mark as final selection yet.
    if (item.kind !== "category") {
      pickerHadSelectionRef.current = true;
    }

    if (item.kind === "category") {
      // Drill into category — keep menu open
      setMode(item.name === "agents" ? "agents" : "resources");
      return false;
    }

    if (item.kind === "agent" && item.agentId) {
      insertMention(editor, range, {
        id: item.agentId,
        name: item.name,
        metadata: { agentId: item.agentId, title: item.name },
        char: "@",
      });
      setMode("categories");
      return;
    }

    if (item.kind === "resource" && item.uri && client) {
      try {
        const result = await readResource(client, item.uri);
        insertMention(editor, range, {
          id: item.uri,
          name: item.uri,
          metadata: result.contents,
          char: "@",
        });
      } catch (error) {
        console.error("[at-mention] Failed to fetch resource:", error);
        toast.error("Failed to load resource. Please try again.");
      }
      setMode("categories");
      return;
    }
  };

  const fetchItems = async (props: { query: string }): Promise<AtItem[]> => {
    const { query } = props;
    const currentMode = modeRef.current;

    if (currentMode === "categories") {
      if (!query.trim()) return CATEGORY_ITEMS;

      // When typing at the top level, search across both agents and resources
      const lq = query.toLowerCase();

      const matchedAgents: AtItem[] = agents
        .filter(
          (agent) =>
            agent.status === "active" &&
            (!agent.id || !isDecopilot(agent.id)) &&
            agent.id !== virtualMcpId &&
            (agent.title.toLowerCase().includes(lq) ||
              agent.description?.toLowerCase().includes(lq)),
        )
        .map((agent) => ({
          name: agent.title,
          title: agent.title,
          description: agent.description ?? undefined,
          icon: agent.icon ?? null,
          kind: "agent" as const,
          agentId: agent.id,
        }));

      const matchedResources: AtItem[] = await (async () => {
        if (!client) return [];
        let cached =
          queryClient.getQueryData<ListResourcesResult>(resourcesQueryKey);
        if (!cached) {
          cached = await queryClient.fetchQuery({
            queryKey: resourcesQueryKey,
            queryFn: () => listResources(client),
            staleTime: 60000,
          });
        }
        return (cached?.resources ?? [])
          .filter(
            (r) =>
              r.uri.toLowerCase().includes(lq) ||
              r.name?.toLowerCase().includes(lq) ||
              r.description?.toLowerCase().includes(lq),
          )
          .map((r) => ({
            name: r.name ?? r.uri,
            title: r.name,
            description: r.description,
            kind: "resource" as const,
            uri: r.uri,
          }));
      })();

      return [...matchedAgents, ...matchedResources];
    }

    if (currentMode === "agents") {
      let filtered = agents.filter(
        (agent) =>
          agent.status === "active" &&
          (!agent.id || !isDecopilot(agent.id)) &&
          agent.id !== virtualMcpId,
      );
      if (query.trim()) {
        const lq = query.toLowerCase();
        filtered = filtered.filter(
          (a) =>
            a.title.toLowerCase().includes(lq) ||
            a.description?.toLowerCase().includes(lq),
        );
      }
      return filtered.map((agent) => ({
        name: agent.title,
        title: agent.title,
        description: agent.description ?? undefined,
        icon: agent.icon ?? null,
        kind: "agent" as const,
        agentId: agent.id,
      }));
    }

    // resources
    if (!client) return [];

    let cached =
      queryClient.getQueryData<ListResourcesResult>(resourcesQueryKey);
    if (!cached) {
      cached = await queryClient.fetchQuery({
        queryKey: resourcesQueryKey,
        queryFn: () => listResources(client),
        staleTime: 60000,
      });
    } else {
      queryClient
        .fetchQuery({
          queryKey: resourcesQueryKey,
          queryFn: () => listResources(client),
          staleTime: 60000,
        })
        .catch(() => {});
    }

    let resources = cached?.resources ?? [];
    if (query.trim()) {
      const lq = query.toLowerCase();
      resources = resources.filter(
        (r) =>
          r.uri.toLowerCase().includes(lq) ||
          r.name?.toLowerCase().includes(lq) ||
          r.description?.toLowerCase().includes(lq),
      );
    }

    return resources.map((r) => ({
      name: r.name ?? r.uri,
      title: r.name,
      description: r.description,
      kind: "resource" as const,
      uri: r.uri,
    }));
  };

  const handleOpenChange = (open: boolean) => {
    if (open) {
      // Fires when the @ picker dropdown actually renders (TipTap's onStart).
      // NOT when a literal "@" is typed — e.g. inside an email address the
      // picker won't open so the event won't fire.
      pickerOpenedAtRef.current = Date.now();
      pickerHadSelectionRef.current = false;
      track("chat_picker_opened", { picker: "@" });
    } else {
      const openedAt = pickerOpenedAtRef.current;
      track("chat_picker_closed", {
        picker: "@",
        outcome: pickerHadSelectionRef.current ? "selected" : "dismissed",
        duration_ms: openedAt ? Date.now() - openedAt : null,
      });
      pickerOpenedAtRef.current = null;
      setMode("categories");
    }
  };

  return (
    <Suggestion<AtItem>
      editor={editor}
      char="@"
      pluginKey="atDropdownMenu"
      queryKey={queryKey}
      queryFn={fetchItems}
      onSelect={handleItemSelect}
      onOpenChange={handleOpenChange}
    />
  );
};
