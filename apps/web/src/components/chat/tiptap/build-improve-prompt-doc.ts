import type { TiptapDoc } from "../types";

export interface ImprovePromptDocInput {
  /** Manager to delegate to. Omit to address the Super Agent directly — it
   *  owns the agent CRUD tools itself, so an agent rewrite needs no mention. */
  managerAgentId?: string;
  managerName?: string;
  kind: "agent" | "automation";
  id: string;
  instructions: string;
}

/**
 * Build a tiptap document that, when sent through the chat, reads as:
 *   Use @<Manager> to improve the instructions of <kind> "<id>".
 *   Here are its current instructions.
 *   <current_instructions>{instructions}</current_instructions>
 *
 * The mention is shaped so derivePartsFromTiptapDoc emits the standard
 * `[DELEGATE TO AGENT: ...]` directive that Decopilot's SUBTASK tool
 * picks up. Without a manager the sentence opens with "Improve the
 * instructions of ..." and no delegation is requested.
 */
export function buildImprovePromptDoc(input: ImprovePromptDocInput): TiptapDoc {
  const { managerAgentId, managerName, kind, id, instructions } = input;

  const tail =
    `the instructions of ${kind} "${id}". ` +
    `Here are its current instructions.\n` +
    `<current_instructions>${instructions}</current_instructions>`;

  const content =
    managerAgentId && managerName
      ? [
          { type: "text", text: "Use " },
          {
            type: "mention",
            attrs: {
              id: managerAgentId,
              name: managerName,
              char: "@",
              metadata: { agentId: managerAgentId, title: managerName },
            },
          },
          { type: "text", text: ` to improve ${tail}` },
        ]
      : [{ type: "text", text: `Improve ${tail}` }];

  return {
    type: "doc",
    content: [{ type: "paragraph", content }],
  };
}
