import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { ArrowRight, Stars02 } from "@untitledui/icons";
import { getPrompt, useMCPClient, useProjectContext } from "@decocms/mesh-sdk";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useState } from "react";
import { toast } from "sonner";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "../dialog-prompt-arguments";
import { createMentionDoc } from "../tiptap/mention/node";
import { useChatStream, useOptionalChatTask } from "../context.tsx";
import { useHomeNextActions } from "@/web/hooks/use-home-next-actions";

export function NextActionChip() {
  const task = useOptionalChatTask();
  const { sendMessage, isStreaming, messages } = useChatStream();
  const { org } = useProjectContext();
  const virtualMcpId = task?.virtualMcpId;
  const { prompts } = useHomeNextActions(org.slug);
  const client = useMCPClient({
    connectionId: virtualMcpId ?? null,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [dialogPrompt, setDialogPrompt] = useState<Prompt | null>(null);

  if (!virtualMcpId || isStreaming) return null;

  // Only suggest a "next" once the user has actually done something in
  // this thread. A user_ask resolution flips the part to `output-available`
  // on the existing assistant message — it doesn't produce a user-role
  // message — so a strict `role === "user"` check would miss it.
  const hasEngagement = messages.some(
    (m) =>
      m.role === "user" ||
      m.parts.some(
        (p) =>
          (p as { type?: string }).type === "tool-user_ask" &&
          (p as { state?: string }).state === "output-available",
      ),
  );
  if (!hasEngagement) return null;

  // home-next-actions is keyed by agentId and already drops completed
  // items server-side, so the first match is this thread's next step.
  // Skip fallback agent-only entries (no promptName) — the chip needs a
  // real prompt to send.
  const next = prompts.find((p) => p.agentId === virtualMcpId && p.promptName);
  if (!next) return null;

  const send = async (prompt: Prompt, args?: PromptArgumentValues) => {
    if (!client) {
      toast.error("MCP client not available");
      return;
    }
    try {
      const result = await getPrompt(client, prompt.name, args);
      // Match `insertMention`'s output (mention atom + trailing " ") so the
      // sent message renders with the same chip styling as the / picker.
      await sendMessage({
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
      });
    } catch (error) {
      console.error("[next-action-chip] failed", error);
      toast.error("Failed to load prompt. Please try again.");
    }
  };

  const handleClick = () => {
    const prompt: Prompt = {
      name: next.promptName,
      title: next.title,
      description: next.description,
      arguments: next.arguments,
      _meta: next._meta,
    };
    if (prompt.arguments && prompt.arguments.length > 0) {
      setDialogPrompt(prompt);
      return;
    }
    void send(prompt);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="group mt-3 flex items-center gap-2 self-start rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
      >
        <Stars02 size={12} className="shrink-0 text-purple-500" />
        <span className="font-medium text-foreground/80">Next:</span>
        <span className="truncate">{next.title}</span>
        <ArrowRight
          size={12}
          className="shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
        />
      </button>
      <PromptArgsDialog
        prompt={dialogPrompt}
        setPrompt={(p) => setDialogPrompt(p)}
        onSubmit={async (values) => {
          const prompt = dialogPrompt;
          setDialogPrompt(null);
          if (prompt) await send(prompt, values);
        }}
      />
    </>
  );
}
