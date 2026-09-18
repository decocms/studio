import {
  START_TASK_PROMPT,
  START_TASK_PROMPT_NAME,
} from "@decocms/shared/task-intake";
import type { TiptapDoc } from "./types";
import { createMentionDoc } from "./tiptap/mention/node";

/**
 * Task mode is the `/start-task` guide, prepended. Same wire shape a user
 * typing `/start-task` produces, so there is no second path through the
 * composer — only a button that types it for them.
 */
export function withTaskIntake(doc: TiptapDoc): TiptapDoc {
  return {
    ...doc,
    content: [
      {
        type: "paragraph",
        content: [
          createMentionDoc({
            id: START_TASK_PROMPT_NAME,
            name: START_TASK_PROMPT_NAME,
            char: "/",
            kind: "prompt",
            metadata: [
              {
                role: "user",
                content: { type: "text", text: START_TASK_PROMPT },
              },
            ],
          }),
        ],
      },
      ...(doc.content ?? []),
    ],
  };
}
