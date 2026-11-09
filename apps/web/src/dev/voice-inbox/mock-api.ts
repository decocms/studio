import { z } from "zod";
import { CREATED_AT, PERSON, type MockTask } from "./data";
import { SUPER_AGENT_ASSIGNEE_ID } from "@/layouts/task-board/config";

let tasks: MockTask[] = [];
let updateTasks: ((tasks: MockTask[]) => void) | undefined;
let personName = PERSON.user.name;
export function setMockTasks(
  next: MockTask[],
  name: string,
  update: (tasks: MockTask[]) => void,
) {
  updateTasks = update;
  tasks = next;
  personName = name;
}

/** Only the standalone entry installs this transport. Unknown API calls fail closed. */
export function installMockApi() {
  const original = window.fetch.bind(window);
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(
      typeof input === "string" ? new URL(input, location.origin) : input,
      init,
    );
    const url = new URL(request.url);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/"))
      return original(input, init);
    const tool = url.pathname.split("/").at(-1);
    if (tool === "TASK_BOARD_PREVIEW_PROBE") return original(input, init);
    const json = (data: unknown, status = 200) =>
      Response.json(data, { status });
    if (url.pathname.endsWith("/get-session")) return json(null);
    if (url.pathname.endsWith("/list-members"))
      return json({
        members: [
          {
            ...PERSON,
            id: PERSON.userId,
            role: "owner",
            user: { id: PERSON.userId, name: personName },
          },
        ],
        total: 1,
      });
    const body = z
      .object({
        taskBoardItemId: z.string().optional(),
        body: z.string().optional(),
        parentId: z.string().optional(),
      })
      .parse(request.method === "POST" ? await request.json() : {});
    const task = tasks.find((task) => task.item.id === body.taskBoardItemId);
    switch (tool) {
      case "COLLECTION_CONNECTIONS_LIST":
        return json({ items: [], total: 0 });
      case "TAGS_LIST":
        return json({ tags: [] });
      case "TASK_BOARD_ACTIVITY_LIST":
        return json({ activity: [] });
      case "TASK_BOARD_ITEM_PRS_GET":
        return json({ prs: task?.pullRequest ? [task.pullRequest] : [] });
      case "TASK_BOARD_COMMENT_CREATE": {
        if (!task || !body.body?.trim())
          return json({ error: "Invalid comment" }, 400);
        const comment = {
          id: crypto.randomUUID(),
          body: body.body,
          author: "person" as const,
          parentId: body.parentId,
        };
        updateTasks?.(
          tasks.map((entry) =>
            entry.item.id === task.item.id
              ? { ...entry, comments: [...entry.comments, comment] }
              : entry,
          ),
        );
        return json({ comment });
      }
      case "TASK_BOARD_COMMENT_LIST":
        return json({
          comments: (task?.comments ?? [])
            .filter((c) => !c.eventLabel?.startsWith("Google Chat"))
            .map((c) => ({
              id: c.id,
              taskBoardItemId: task?.item.id,
              parentId: c.parentId ?? null,
              authorId:
                c.author === "agent"
                  ? SUPER_AGENT_ASSIGNEE_ID
                  : (c.authorLabel ?? PERSON.userId),
              body: c.body,
              audience: c.audience ?? "human",
              threadId: null,
              resolved: c.resolved ?? false,
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            })),
        });
      default:
        return json(
          { error: "This action is not available in the local prototype." },
          501,
        );
    }
  };
  window.fetch = Object.assign(mockFetch, {
    preconnect: window.fetch.preconnect,
  });
}
