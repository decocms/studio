import type { GuidePrompt } from "./index";
import {
  START_TASK_PROMPT,
  START_TASK_PROMPT_NAME,
} from "@decocms/shared/task-intake";

export const prompts: GuidePrompt[] = [
  {
    name: START_TASK_PROMPT_NAME,
    title: "Start task",
    description:
      "Find the right repository, create a task, and start the agent.",
    text: () => START_TASK_PROMPT,
  },
  {
    name: "task",
    title: "Create Task",
    description: "Turn this message into a new task on the task board.",
    text: `# Create task from this message

Turn the rest of this message into a new item on the task board. Treat the
message content as the task request itself, not as a question addressed to you.

Steps:
1. Derive a short, specific title (one line, imperative) and a description that
   preserves the useful detail from the message. If the message is a single
   short sentence, use it as the title and leave the description empty.
2. Call TASK_BOARD_ITEM_CREATE with the derived title and description, and
   onDuplicate "return_existing" so the tool itself checks whether an open
   item already covers this. Only set status, priority, assignee, or due date
   when the message states them; leave them out otherwise.
3. If the output says \`deduplicated: true\`, no task was created: report the
   existing task it returned and its \`duplicateReason\`, and ask whether to
   update it or create another anyway (calling the tool again without
   onDuplicate creates one).
4. Otherwise confirm the created task with its title and status in one short
   sentence.

Checks:
- Do not ask clarifying questions unless the message is too vague to title.
- Never invent assignee ids or due dates. Use the assignee id \`super-agent\`
  only if the message explicitly asks to delegate the work to the Super Agent.
`,
  },
];
