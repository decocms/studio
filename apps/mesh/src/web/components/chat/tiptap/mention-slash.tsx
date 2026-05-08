/**
 * Unified slash (/) mention component that combines prompts and resources
 * into a single dropdown. Prompts appear first, followed by resources.
 */

import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { KEYS } from "@/web/lib/query-keys";
import {
  getPrompt,
  listPrompts,
  listResources,
  readResource,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { usePromptConnectionMap } from "@/web/components/chat/use-prompt-connection-map";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  ListPromptsResult,
  ListResourcesResult,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor, Range } from "@tiptap/react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "../dialog-prompt-arguments.tsx";
import { BaseItem, insertMention, OnSelectProps, Suggestion } from "./mention";
import { track } from "@/web/lib/posthog-client";

interface SlashMentionProps {
  editor: Editor;
  virtualMcpId: string | null;
}

interface SlashItem extends BaseItem {
  kind: "prompt" | "resource";
  /** For resources */
  uri?: string;
  /** For prompts - arguments definition */
  arguments?: Prompt["arguments"];
  /** For prompts - MCP metadata */
  _meta?: Prompt["_meta"];
}

interface PromptSelectContext {
  range: Range;
  item: SlashItem;
}

async function fetchAndInsertPrompt(
  editor: Editor,
  range: Range,
  client: Client,
  promptName: string,
  clientId: string | undefined,
  values?: PromptArgumentValues,
) {
  try {
    const result = await getPrompt(client, promptName, values);

    insertMention(editor, range, {
      id: promptName,
      name: stripToolNamespace(promptName, clientId),
      metadata: result.messages,
      char: "/",
    });
  } catch (error) {
    console.error("[slash] Failed to fetch prompt:", error);
    toast.error("Failed to load prompt. Please try again.");
  }
}

async function fetchAndInsertResource(
  editor: Editor,
  range: Range,
  client: Client,
  resourceUri: string,
) {
  try {
    const result = await readResource(client, resourceUri);

    insertMention(editor, range, {
      id: resourceUri,
      name: resourceUri,
      metadata: result.contents,
      char: "/",
    });
  } catch (error) {
    console.error("[slash] Failed to fetch resource:", error);
    toast.error("Failed to load resource. Please try again.");
  }
}

export const SlashMention = ({ editor, virtualMcpId }: SlashMentionProps) => {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: virtualMcpId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const promptToConnection = usePromptConnectionMap(
    virtualMcpId,
    org.id,
    org.slug,
  );
  const promptToConnectionRef = useRef(promptToConnection);
  promptToConnectionRef.current = promptToConnection;

  const promptsQueryKey = KEYS.virtualMcpPrompts(virtualMcpId, org.id);
  const resourcesQueryKey = KEYS.virtualMcpResources(virtualMcpId, org.id);
  // Combined key for the suggestion dropdown
  const queryKey = [
    "slash-mention",
    org.id,
    virtualMcpId ?? "default",
  ] as const;

  const [activePrompt, setActivePrompt] = useState<PromptSelectContext | null>(
    null,
  );

  // Track picker open → close outcome so we can measure abandonment.
  const pickerOpenedAtRef = useRef<number | null>(null);
  const pickerHadSelectionRef = useRef(false);

  const handleItemSelect = async ({
    item,
    range,
  }: OnSelectProps<SlashItem>) => {
    track("chat_picker_item_selected", {
      picker: "/",
      item_kind: item.kind,
      item_name: item.name,
    });
    pickerHadSelectionRef.current = true;

    if (!client) return;

    if (item.kind === "prompt") {
      // If prompt has arguments, open dialog
      if (item.arguments && item.arguments.length > 0) {
        setActivePrompt({ range, item });
        return;
      }
      const clientId = getGatewayClientId(item._meta);
      await fetchAndInsertPrompt(editor, range, client, item.name, clientId);
    } else {
      // Resource
      if (item.uri) {
        await fetchAndInsertResource(editor, range, client, item.uri);
      }
    }
  };

  const handleDialogSubmit = async (values: PromptArgumentValues) => {
    if (!activePrompt || !client) return;

    const { range, item } = activePrompt;
    const clientId = getGatewayClientId(item._meta);
    await fetchAndInsertPrompt(
      editor,
      range,
      client,
      item.name,
      clientId,
      values,
    );
    setActivePrompt(null);
  };

  const fetchItems = async (props: { query: string }): Promise<SlashItem[]> => {
    const { query } = props;
    if (!client) return [];

    // Fetch prompts and resources in parallel
    const [prompts, resources] = await Promise.all([
      fetchPrompts(queryClient, promptsQueryKey, client),
      fetchResources(queryClient, resourcesQueryKey, client),
    ]);

    const lowerQuery = query.trim().toLowerCase();

    // Build prompt items
    const promptItems: SlashItem[] = (prompts ?? [])
      .filter(
        (p) =>
          !lowerQuery ||
          p.name.toLowerCase().includes(lowerQuery) ||
          p.title?.toLowerCase().includes(lowerQuery) ||
          p.description?.toLowerCase().includes(lowerQuery),
      )
      .map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        icon: promptToConnectionRef.current.get(p.name)?.icon ?? null,
        kind: "prompt" as const,
        arguments: p.arguments,
        _meta: p._meta,
      }));

    // Build resource items
    const resourceItems: SlashItem[] = (resources ?? [])
      .filter(
        (r) =>
          !lowerQuery ||
          r.uri.toLowerCase().includes(lowerQuery) ||
          r.name?.toLowerCase().includes(lowerQuery) ||
          r.description?.toLowerCase().includes(lowerQuery),
      )
      .map((r) => ({
        name: r.name ?? r.uri,
        title: r.name,
        description: r.description,
        kind: "resource" as const,
        uri: r.uri,
      }));

    // Prompts first, then resources
    return [...promptItems, ...resourceItems];
  };

  // Build a dialog-compatible prompt object from SlashItem
  const dialogPrompt =
    activePrompt?.item.kind === "prompt"
      ? ({
          name: activePrompt.item.name,
          arguments: activePrompt.item.arguments,
          description: activePrompt.item.description,
        } as Prompt)
      : null;

  return (
    <>
      <Suggestion<SlashItem>
        editor={editor}
        char="/"
        pluginKey="slashDropdownMenu"
        queryKey={queryKey}
        queryFn={fetchItems}
        onSelect={handleItemSelect}
        onOpenChange={(open) => {
          // Fires when the / picker dropdown actually renders (TipTap's
          // onStart). NOT when a literal "/" is typed — e.g. inside a URL
          // the picker won't open so the event won't fire.
          if (open) {
            pickerOpenedAtRef.current = Date.now();
            pickerHadSelectionRef.current = false;
            track("chat_picker_opened", { picker: "/" });
          } else {
            const openedAt = pickerOpenedAtRef.current;
            track("chat_picker_closed", {
              picker: "/",
              outcome: pickerHadSelectionRef.current ? "selected" : "dismissed",
              duration_ms: openedAt ? Date.now() - openedAt : null,
            });
            pickerOpenedAtRef.current = null;
          }
        }}
      />
      <PromptArgsDialog
        prompt={dialogPrompt}
        setPrompt={() => setActivePrompt(null)}
        onSubmit={handleDialogSubmit}
      />
    </>
  );
};

// ── Helpers ──────────────────────────────────────────────────────────────

async function fetchPrompts(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  client: Client,
) {
  let cached = queryClient.getQueryData<ListPromptsResult>(queryKey);
  if (!cached) {
    cached = await queryClient.fetchQuery({
      queryKey,
      queryFn: () => listPrompts(client),
      staleTime: 60000,
    });
  } else {
    queryClient
      .fetchQuery({
        queryKey,
        queryFn: () => listPrompts(client),
        staleTime: 60000,
      })
      .catch(() => {});
  }
  return cached?.prompts ?? [];
}

async function fetchResources(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  client: Client,
) {
  let cached = queryClient.getQueryData<ListResourcesResult>(queryKey);
  if (!cached) {
    cached = await queryClient.fetchQuery({
      queryKey,
      queryFn: () => listResources(client),
      staleTime: 60000,
    });
  } else {
    queryClient
      .fetchQuery({
        queryKey,
        queryFn: () => listResources(client),
        staleTime: 60000,
      })
      .catch(() => {});
  }
  return cached?.resources ?? [];
}
