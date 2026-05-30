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
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "@/web/components/chat/dialog-prompt-arguments";
import { useThreadActions } from "@/web/components/chat/store/hooks";
import { createMentionDoc } from "@/web/components/chat/tiptap/mention/node";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { writeStoredAutosend } from "@/web/lib/autosend";

export interface UseStartThreadFromPromptResult {
  /** Trigger from a card click. Opens args dialog if needed. */
  start: (prompt: Prompt) => Promise<void>;
  /**
   * Start a fresh thread with `agentId` without seeding a prompt — used by the
   * fallback cards for default home agents that expose no prompts.
   */
  startBlank: () => Promise<void>;
  /** Render this in your component to mount the args dialog. */
  dialog: ReactNode;
  /** Exposed for tests / loading states. */
  dialogPrompt: Prompt | null;
  /**
   * True while a thread creation is in flight. Consumers should disable
   * their trigger button so repeated clicks during the autosend round-trip
   * can't spawn duplicate threads.
   */
  starting: boolean;
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
  const [starting, setStarting] = useState(false);
  // `inFlightRef` is the race-safe guard — `starting` (state) is one render
  // behind on rapid double-clicks, so a ref is what actually prevents the
  // second invocation from getting past the gate before React commits.
  const inFlightRef = useRef(false);

  const loadAndStart = async (prompt: Prompt, args?: PromptArgumentValues) => {
    if (!client) {
      toast.error("MCP client not available");
      return;
    }
    if (inFlightRef.current) return;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- in-flight guard for duplicate-click prevention
    inFlightRef.current = true;
    setStarting(true);
    try {
      const result = await getPrompt(client, prompt.name, args);
      // Mirror the editor's `/`-mention insertion shape (mention atom +
      // trailing " " text node — see `tiptap/mention/node.tsx`'s
      // `insertMention`). Storing this on autosend (and re-deriving parts
      // at send time) routes the message through the rich renderer so the
      // sent user message shows the chip styling, matching the slash and
      // in-thread icebreaker flows.
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
              { type: "text" as const, text: " " },
            ],
          },
        ],
      };

      const newId = crypto.randomUUID();
      writeStoredAutosend(sessionStorage, locator, newId, { tiptapDoc });
      await create({ id: newId, virtual_mcp_id: agentId });
      setTaskId(newId, agentId, { autosend: true });
    } catch (error) {
      console.error("[start-thread-from-prompt] failed", error);
      toast.error("Failed to start thread. Please try again.");
    } finally {
      // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- release in-flight guard
      inFlightRef.current = false;
      setStarting(false);
    }
  };

  const start = async (prompt: Prompt) => {
    if (inFlightRef.current) return;
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

  const startBlank = async () => {
    if (inFlightRef.current) return;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- in-flight guard for duplicate-click prevention
    inFlightRef.current = true;
    setStarting(true);
    try {
      const newId = crypto.randomUUID();
      await create({ id: newId, virtual_mcp_id: agentId });
      setTaskId(newId, agentId);
    } catch (error) {
      console.error("[start-thread-from-prompt] startBlank failed", error);
      toast.error("Failed to start thread. Please try again.");
    } finally {
      // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- release in-flight guard
      inFlightRef.current = false;
      setStarting(false);
    }
  };

  const dialog = (
    <PromptArgsDialog
      prompt={dialogPrompt}
      setPrompt={(p) => setDialogPrompt(p)}
      onSubmit={handleDialogSubmit}
    />
  );

  return { start, startBlank, dialog, dialogPrompt, starting };
}
