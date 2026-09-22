import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";

type BoardAnswer = ToolOutput<"TASK_BOARD_ITEM_LIST">;
type BoardItem = BoardAnswer["items"][number];

/**
 * Cards for the board rendered BEHIND the Kanban paywall.
 *
 * Invented, and deliberately generic — this is a sales backdrop shown to an org
 * that has no board yet, so it must not read as their data (nothing is theirs
 * to read) and must not carry a real customer's name. Every timestamp is
 * relative to render so the backdrop never shows a stale date.
 */

const AT = new Date().toISOString();

function card(
  id: string,
  title: string,
  status: BoardItem["status"],
  type: BoardItem["type"],
  priority: BoardItem["priority"],
  sortOrder: number,
): BoardItem {
  return {
    id,
    organizationId: "preview",
    title,
    description: null,
    repositoryId: null,
    status,
    priority,
    type,
    assigneeId: null,
    assignedBy: null,
    repo: null,
    dueDate: null,
    sortOrder,
    keySeq: sortOrder,
    externalUrl: null,
    previewRoutes: [],
    source: null,
    retryAttempts: 0,
    reviewCycleStartedAt: null,
    threads: [],
    tags: [],
    reviewVerdicts: [],
    createdBy: "preview",
    createdAt: AT,
    updatedBy: "preview",
    updatedAt: AT,
  };
}

export function mockBoardAnswer(): BoardAnswer {
  return {
    items: [
      card("p1", "Fix checkout shipping estimate", "todo", "bug", "high", 1),
      card(
        "p2",
        "Add size guide to product page",
        "todo",
        "feature",
        "medium",
        2,
      ),
      card("p3", "Compress hero images", "todo", "chore", "low", 3),
      card(
        "p4",
        "Rewrite category descriptions",
        "in_progress",
        "feature",
        "medium",
        4,
      ),
      card("p5", "Audit broken redirects", "in_progress", "chore", "high", 5),
      card(
        "p6",
        "New arrivals landing page",
        "in_review",
        "feature",
        "high",
        6,
      ),
      card("p7", "Speed up search results", "done", "chore", "medium", 7),
      card("p8", "Black Friday banner", "done", "feature", "urgent", 8),
    ],
    repos: [],
    columns: [],
  };
}
