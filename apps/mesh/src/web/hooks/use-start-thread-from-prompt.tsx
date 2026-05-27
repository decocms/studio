/**
 * useStartThreadFromPrompt
 *
 * Starts a new thread on `agentId` and seeds it with an MCP prompt as the
 * first user message. Mirrors `ice-breakers.tsx`'s prompt-selection flow
 * (args dialog gating + getPrompt + mention chip), but writes to the
 * autosend buffer and creates a fresh thread instead of sending into the
 * current chat.
 *
 * Usage:
 *   const { start, dialog } = useStartThreadFromPrompt({ agentId });
 *   <NextActionCard onClick={() => start(prompt)} />
 *   {dialog}
 */

import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { getPrompt, useMCPClient, useProjectContext } from "@decocms/mesh-sdk";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "@/web/components/chat/dialog-prompt-arguments";
import { derivePartsFromTiptapDoc } from "@/web/components/chat/derive-parts";
import { useThreadActions } from "@/web/components/chat/store/hooks";
import { createMentionDoc } from "@/web/components/chat/tiptap/mention/node";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { writeStoredAutosend } from "@/web/lib/autosend";

export interface UseStartThreadFromPromptResult {
  /** Trigger from a card click. Opens args dialog if needed. */
  start: (prompt: Prompt) => Promise<void>;
  /** Render this in your component to mount the args dialog. */
  dialog: ReactNode;
  /** Exposed for tests / loading states. */
  dialogPrompt: Prompt | null;
}

export function useStartThreadFromPrompt({
  agentId,
}: {
  agentId: string;
}): UseStartThreadFromPromptResult {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: agentId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { create } = useThreadActions();
  const { setTaskId } = usePanelActions();
  const [dialogPrompt, setDialogPrompt] = useState<Prompt | null>(null);

  const loadAndStart = async (prompt: Prompt, args?: PromptArgumentValues) => {
    if (!client) {
      toast.error("MCP client not available");
      return;
    }
    try {
      const result = await getPrompt(client, prompt.name, args);
      const tiptapDoc = {
        type: "doc" as const,
        content: [
          {
            type: "paragraph",
            content: [
              createMentionDoc({
                id: prompt.name,
                name: stripToolNamespace(
                  prompt.name,
                  getGatewayClientId(prompt._meta),
                ),
                metadata: result.messages,
                char: "/",
                kind: "prompt",
                args,
              }),
            ],
          },
        ],
      };
      const parts = derivePartsFromTiptapDoc(tiptapDoc);

      const newId = crypto.randomUUID();
      writeStoredAutosend(sessionStorage, locator, newId, { parts });
      await create({ id: newId, virtual_mcp_id: agentId });
      setTaskId(newId, agentId);
    } catch (error) {
      console.error("[start-thread-from-prompt] failed", error);
      toast.error("Failed to start thread. Please try again.");
    }
  };

  const start = async (prompt: Prompt) => {
    if (prompt.arguments && prompt.arguments.length > 0) {
      setDialogPrompt(prompt);
      return;
    }
    await loadAndStart(prompt);
  };

  const handleDialogSubmit = async (values: PromptArgumentValues) => {
    if (!dialogPrompt) return;
    const prompt = dialogPrompt;
    setDialogPrompt(null);
    await loadAndStart(prompt, values);
  };

  const dialog = (
    <PromptArgsDialog
      prompt={dialogPrompt}
      setPrompt={(p) => setDialogPrompt(p)}
      onSubmit={handleDialogSubmit}
    />
  );

  return { start, dialog, dialogPrompt };
}
