import type { GuidePrompt } from "./index";

export const prompts: GuidePrompt[] = [
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
2. Call TASK_BOARD_ITEM_LIST first and check whether an open item already
   covers this. If one clearly matches, do not create a duplicate — report the
   existing task and ask whether to update it or create another anyway.
3. Otherwise call TASK_BOARD_ITEM_CREATE with the derived title and
   description. Only set status, priority, assignee, or due date when the
   message states them; leave them out otherwise.
4. Confirm the created task with its title and status in one short sentence.

Checks:
- Do not ask clarifying questions unless the message is too vague to title.
- Never invent assignee ids or due dates. Use the assignee id \`super-agent\`
  only if the message explicitly asks to delegate the work to the Super Agent.
`,
  },
];
