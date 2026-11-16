import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, ClipboardCheck } from "@untitledui/icons";
import { z } from "zod";
import { cn } from "@decocms/ui/lib/utils.ts";
import { taskKey } from "@decocms/shared/task-key";
import { useTaskBoardItems } from "@/hooks/use-task-board-items";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { laneHeader } from "@/layouts/task-board/config";
import { taskRouteSegment } from "@/layouts/task-board/task-route";
import { useProjectContext, useVirtualMCPNonBlocking } from "@/sdk";
import { AgentAvatar } from "@/components/agent-icon";
import { unwrapResult } from "./tool-call-part/utils";

const CreatedTaskSchema = z.object({
  item: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    keySeq: z.number().nullable(),
    virtualMcpId: z.string().nullable(),
  }),
});

type CreatedTask = z.infer<typeof CreatedTaskSchema>["item"];

/** The task a finished `TASK_BOARD_ITEM_CREATE` call filed. */
export function createdTaskOf(part: {
  state: string;
  output?: unknown;
}): CreatedTask | null {
  if (part.state !== "output-available") return null;
  const parsed = CreatedTaskSchema.safeParse(
    unwrapResult(part.output) ?? part.output,
  );
  return parsed.success ? parsed.data.item : null;
}

/** A task the chat filed, kept current from the board; the whole card opens it. */
export function TaskCreatedCard({ task }: { task: CreatedTask }) {
  const t = useT();
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  const { items } = useTaskBoardItems();
  const loaded = items.find((item) => item.id === task.id);
  const live = loaded ?? task;
  // The board opens a task from its loaded list; one the chat just filed may not be in it yet.
  const syncBoard = () => {
    if (!loaded) {
      void queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardItems(locator),
      });
    }
  };
  const project = useVirtualMCPNonBlocking(live.virtualMcpId);
  const lane = laneHeader(live.status, t);
  const LaneIcon = lane.visual.icon;
  const key = taskKey(org.slug, live.keySeq);
  const taskSegment = taskRouteSegment(org.slug, live);
  const className =
    "group my-2 flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 shadow-xs transition-colors hover:bg-accent/50 focus-ring";
  const body = (
    <>
      {project ? (
        <AgentAvatar
          icon={(project.icon as string | null | undefined) ?? null}
          name={project.title}
          size="sm"
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ClipboardCheck size={16} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {live.title}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <LaneIcon
            className={cn("size-3.5 shrink-0", lane.visual.iconClassName)}
            aria-hidden
          />
          <span className="shrink-0">{lane.label}</span>
          {[key, project?.title].filter(Boolean).map((part) => (
            <span
              key={part}
              className="truncate before:mr-1.5 before:content-['·']"
            >
              {part}
            </span>
          ))}
        </span>
      </span>
      <ChevronRight
        size={16}
        aria-hidden
        className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </>
  );
  // A project's task opens on its own board, where the sidebar and breadcrumb belong.
  return live.virtualMcpId ? (
    <Link
      to="/$org/projects/$agentId/tasks/{-$taskKey}"
      params={{
        org: org.slug,
        agentId: live.virtualMcpId,
        taskKey: taskSegment,
      }}
      className={className}
      onClick={syncBoard}
    >
      {body}
    </Link>
  ) : (
    <Link
      to="/$org/tasks/{-$taskKey}"
      params={{ org: org.slug, taskKey: taskSegment }}
      className={className}
      onClick={syncBoard}
    >
      {body}
    </Link>
  );
}
