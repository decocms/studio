import type { TaskBoardItem, TaskBoardItemPr } from "./config";

/**
 * The context text seeded into a fresh chat started from a task. Beyond the
 * task's own title + description, it references the task's linked PRs and the
 * other chats already on the task, so the agent picks up where prior work left
 * off instead of starting cold. Pure so it's unit-testable.
 */
export function buildTaskChatContext(
  task: Pick<TaskBoardItem, "title" | "description" | "threads">,
  prs: TaskBoardItemPr[] = [],
): string {
  const sections: string[] = [
    [`# Task: ${task.title}`, task.description?.trim()]
      .filter(Boolean)
      .join("\n\n"),
  ];

  if (prs.length > 0) {
    const lines = prs.map((pr) => {
      const state = pr.merged
        ? "merged"
        : (pr.state ?? (pr.draft ? "draft" : "open"));
      const label = pr.title?.trim() || `${pr.repoOwner}/${pr.repoName}`;
      return `- #${pr.number} ${label} [${state}] ${pr.url}`;
    });
    sections.push(["## Linked pull requests", ...lines].join("\n"));
  }

  if (task.threads.length > 0) {
    const lines = task.threads.map((t) => {
      const title = t.title?.trim() || "Untitled chat";
      return t.status ? `- ${title} [${t.status}]` : `- ${title}`;
    });
    sections.push(["## Other chats on this task", ...lines].join("\n"));
  }

  return sections.join("\n\n");
}
