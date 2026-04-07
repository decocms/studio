import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { KEYS } from "@/web/lib/query-keys";
import {
  getPrompt,
  listPrompts,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { usePromptConnectionMap } from "@/web/components/chat/use-prompt-connection-map";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  ListPromptsResult,
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
import { insertMention, OnSelectProps, Suggestion } from "./mention";

interface PromptSelectContext {
  range: Range;
  item: Prompt;
}

interface PromptsMentionProps {
  editor: Editor;
  virtualMcpId: string | null;
}

/**
 * Fetches a prompt and inserts it as a mention node in the editor.
 */
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
    console.error("[prompt] Failed to fetch prompt:", error);
    toast.error("Failed to load prompt. Please try again.");
  }
}

export const PromptsMention = ({
  editor,
  virtualMcpId,
}: PromptsMentionProps) => {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: virtualMcpId,
    orgId: org.id,
  });
  const promptToConnection = usePromptConnectionMap(virtualMcpId, org.id);
  const promptToConnectionRef = useRef(promptToConnection);
  promptToConnectionRef.current = promptToConnection;
  // Use the query key helper which handles null (default virtual MCP)
  const queryKey = KEYS.virtualMcpPrompts(virtualMcpId, org.id);
  const [activePrompt, setActivePrompt] = useState<PromptSelectContext | null>(
    null,
  );

  const handleItemSelect = async ({ item, range }: OnSelectProps<Prompt>) => {
    // If prompt has arguments, open dialog
    if (item.arguments && item.arguments.length > 0) {
      setActivePrompt({ range, item: item });
      return;
    }

    // No arguments - fetch and insert directly
    if (!client) return;
    const clientId = getGatewayClientId(item._meta);
    await fetchAndInsertPrompt(editor, range, client, item.name, clientId);
  };

  const handleDialogSubmit = async (values: PromptArgumentValues) => {
    if (!activePrompt || !client) return;

    const { range, item: prompt } = activePrompt;
    const clientId = getGatewayClientId(prompt._meta);
    await fetchAndInsertPrompt(
      editor,
      range,
      client,
      prompt.name,
      clientId,
      values,
    );
    setActivePrompt(null);
  };

  const fetchItems = async (props: { query: string }) => {
    const { query } = props;

    if (!client) return [];

    // Try to get from cache first (even if stale)
    let virtualMcpPrompts =
      queryClient.getQueryData<ListPromptsResult>(queryKey);

    // If not in cache or we want fresh data, fetch from network
    // fetchQuery will use cache if fresh, otherwise fetch
    if (!virtualMcpPrompts) {
      const result = await queryClient.fetchQuery({
        queryKey,
        queryFn: () => listPrompts(client),
        staleTime: 60000, // 1 minute
      });
      virtualMcpPrompts = result;
    } else {
      // Prefetch in background to ensure fresh data
      queryClient
        .fetchQuery({
          queryKey,
          queryFn: () => listPrompts(client),
          staleTime: 60000,
        })
        .catch(() => {
          // Ignore errors in background fetch
        });
    }

    // Ensure we have prompts (fallback to empty array)
    if (!virtualMcpPrompts.prompts) {
      return [];
    }

    // Filter prompts based on query
    let filteredPrompts = virtualMcpPrompts.prompts;
    if (query.trim()) {
      const lowerQuery = query.toLowerCase();
      filteredPrompts = virtualMcpPrompts.prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(lowerQuery) ||
          p.title?.toLowerCase().includes(lowerQuery) ||
          p.description?.toLowerCase().includes(lowerQuery),
      );
    }

    return filteredPrompts.map((p) => ({
      ...p,
      icon: promptToConnectionRef.current.get(p.name)?.icon ?? null,
    }));
  };

  return (
    <>
      <Suggestion<Prompt>
        editor={editor}
        char="/"
        pluginKey="promptsDropdownMenu"
        queryKey={queryKey}
        queryFn={fetchItems}
        onSelect={handleItemSelect}
      />
      <PromptArgsDialog
        prompt={activePrompt?.item ?? null}
        setPrompt={() => setActivePrompt(null)}
        onSubmit={handleDialogSubmit}
      />
    </>
  );
};
