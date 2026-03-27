/**
 * Global Tasks Side Panel
 *
 * When inside a project: shows project name header (Cursor-style) with
 * settings, New session button, pinned Views, then tasks for that project.
 *
 * When global (no project): shows "Tasks" header, New task button, all tasks.
 */

import { Page } from "@/web/components/page";

import { useChatPanel } from "@/web/contexts/panel-context";
import { Browser, Edit05, Loading01, Settings01 } from "@untitledui/icons";
import { useVirtualMCPActions, useVirtualMCP } from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { Suspense, useEffect, useRef, useState, useTransition } from "react";
import { isMac } from "@/web/lib/keyboard-shortcuts";
import { ErrorBoundary } from "../error-boundary";
import { Chat } from "./index";
import { useChatTask } from "./context";
import { OwnerFilter, TaskListContent } from "./tasks-panel";
import { cn } from "@deco/ui/lib/utils.ts";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { IconPicker } from "@/web/components/icon-picker.tsx";
import { useVirtualMCPURLContext } from "@/web/contexts/virtual-mcp-context";

// ────────────────────────────────────────
// Shared nav item style — used by New session and view buttons
// ────────────────────────────────────────

const navItemClass =
  "flex items-center gap-2.5 mx-2 px-3 h-10 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors w-[calc(100%-1rem)]";

function NewTaskButton({
  onClick,
  isPending,
  label = "New task",
}: {
  onClick: () => void;
  isPending: boolean;
  label?: string;
}) {
  return (
    <Tooltip delayDuration={600}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={isPending}
          className={cn(
            navItemClass,
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {isPending ? (
            <Loading01 size={16} className="shrink-0 animate-spin" />
          ) : (
            <Edit05 size={16} className="shrink-0" />
          )}
          <span className="text-foreground">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        New task
        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
          {isMac ? "⇧⌘S" : "⇧Ctrl+S"}
        </kbd>
      </TooltipContent>
    </Tooltip>
  );
}

// ────────────────────────────────────────
// Views section — pinned UIs for the project
// ────────────────────────────────────────

function ProjectViewsSection({ project }: { project: VirtualMCPEntity }) {
  const virtualMcpCtx = useVirtualMCPURLContext();

  const pinnedViews =
    ((project.metadata?.ui as Record<string, unknown> | null | undefined)
      ?.pinnedViews as Array<{
      connectionId: string;
      toolName: string;
      label: string;
      icon: string | null;
    }> | null) ?? [];

  if (pinnedViews.length === 0) return null;

  // Determine which pinned view is currently active
  const currentMain = virtualMcpCtx?.mainView;
  const isExtAppActive = (view: { connectionId: string; toolName: string }) =>
    currentMain?.type === "ext-apps" &&
    currentMain.id === view.connectionId &&
    currentMain.toolName === view.toolName;

  return (
    <>
      {pinnedViews.map((view) => (
        <button
          key={`${view.connectionId}-${view.toolName}`}
          type="button"
          onClick={() =>
            isExtAppActive(view)
              ? virtualMcpCtx?.openMainView("default")
              : virtualMcpCtx?.openMainView("ext-apps", {
                  id: view.connectionId,
                  toolName: view.toolName,
                })
          }
          className={cn(
            navItemClass,
            isExtAppActive(view) && "bg-accent text-foreground",
          )}
        >
          {view.icon ? (
            <img src={view.icon} alt="" className="size-4 rounded shrink-0" />
          ) : (
            // Keep in sync with use-project-sidebar-items.tsx pinned view icon
            <Browser size={16} className="shrink-0" />
          )}
          <span className="truncate text-foreground">
            {view.label || view.toolName}
          </span>
        </button>
      ))}
    </>
  );
}

// ────────────────────────────────────────
// Space identity header — inline-editable name, description, icon, pin
// ────────────────────────────────────────

function SpaceIdentityHeader({ project }: { project: VirtualMCPEntity }) {
  const actions = useVirtualMCPActions();
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description ?? "");
  const initialRenderRef = useRef(true);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — debounced title sync
  useEffect(() => {
    if (initialRenderRef.current) return;
    const trimmed = title.trim();
    if (!trimmed || trimmed === project.title) return;
    const timer = setTimeout(() => {
      actions.update.mutate({ id: project.id, data: { title: trimmed } });
    }, 1000);
    return () => clearTimeout(timer);
  }, [title]);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — debounced description sync
  useEffect(() => {
    if (initialRenderRef.current) return;
    if (description === (project.description ?? "")) return;
    const timer = setTimeout(() => {
      actions.update.mutate({
        id: project.id,
        data: { description },
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [description]);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — skip initial render for debounce effects
  useEffect(() => {
    initialRenderRef.current = false;
  }, []);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDescription(e.target.value);
  };

  const handleIconChange = (icon: string | null) => {
    actions.update.mutate({ id: project.id, data: { icon } });
  };

  const handleColorChange = (color: string) => {
    actions.update.mutate({
      id: project.id,
      data: {
        metadata: {
          ...project.metadata,
          ui: {
            ...(project.metadata?.ui as Record<string, unknown> | undefined),
            themeColor: color,
          },
        },
      },
    });
  };

  return (
    <div className="flex items-center gap-3 pl-3 pr-4 pt-3 pb-3">
      <IconPicker
        value={project.icon}
        onChange={handleIconChange}
        onColorChange={handleColorChange}
        name={project.title || "Space"}
        size="sm+"
        className="shrink-0 self-start"
        avatarClassName="[&_svg]:w-1/2 [&_svg]:h-1/2"
        showHoverOverlay={false}
      />
      <div className="flex flex-col flex-1 min-w-0">
        <input
          type="text"
          value={title}
          onChange={handleTitleChange}
          placeholder="Space Name"
          className="text-sm font-medium text-foreground bg-transparent border-none outline-none px-1 -mx-1 rounded hover:bg-input/25 focus:bg-input/25 transition-colors w-full truncate"
        />
        <input
          type="text"
          value={description}
          onChange={handleDescriptionChange}
          placeholder="Add a description..."
          className="text-sm text-muted-foreground bg-transparent border-none outline-none px-1 -mx-1 rounded hover:bg-input/25 focus:bg-input/25 transition-colors w-full truncate"
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────
// Panel content
// ────────────────────────────────────────

function TasksPanelContent({
  virtualMcpId: virtualMcpIdProp,
}: {
  virtualMcpId?: string;
}) {
  const [, setChatOpen] = useChatPanel();
  const { createTask, openTask } = useChatTask();
  const virtualMcpCtx = useVirtualMCPURLContext();
  const [isPending, startTransition] = useTransition();

  const virtualMcpId = virtualMcpIdProp ?? null;

  const virtualMcp = useVirtualMCP(virtualMcpId);

  const handleNewTask = () => {
    startTransition(() => {
      createTask();
      setChatOpen(true);
    });
  };

  const isSettingsActive = virtualMcpCtx?.mainView?.type === "settings";

  return (
    <div className="flex flex-col h-full">
      {/* Space identity */}
      {virtualMcp && (
        <SpaceIdentityHeader key={virtualMcp.id} project={virtualMcp} />
      )}

      {/* Header */}
      {!virtualMcp && (
        <Page.Header className="flex-none" hideSidebarTrigger>
          <Page.Header.Left className="gap-2">
            <span className="text-sm font-medium text-foreground">Tasks</span>
          </Page.Header.Left>
          <Page.Header.Right className="gap-1">
            <OwnerFilter />
          </Page.Header.Right>
        </Page.Header>
      )}

      {/* Nav items: New session + Settings + Views flow as one group */}
      <div className="py-2 flex flex-col gap-0.5">
        <NewTaskButton
          onClick={handleNewTask}
          isPending={isPending}
          label="New task"
        />
        {virtualMcp && (
          <button
            type="button"
            onClick={() =>
              isSettingsActive
                ? virtualMcpCtx?.openMainView("default")
                : virtualMcpCtx?.openMainView("settings")
            }
            className={cn(
              navItemClass,
              isSettingsActive && "bg-accent text-foreground",
            )}
          >
            <Settings01 size={16} className="shrink-0" />
            <span className="text-foreground">Settings</span>
          </button>
        )}
        {virtualMcp && <ProjectViewsSection project={virtualMcp} />}
      </div>

      {/* Task list */}
      <TaskListContent
        virtualMcpId={virtualMcpId}
        onTaskSelect={(taskId) => {
          openTask(taskId);
          setChatOpen(true);
        }}
      />
    </div>
  );
}

function TasksPanelSkeleton() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Header skeleton */}
      <div className="flex items-center gap-3 pl-3 pr-4 pt-3 pb-3">
        <Skeleton className="size-10 rounded-xl shrink-0" />
        <div className="flex flex-col flex-1 min-w-0 gap-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-36" />
        </div>
      </div>

      {/* Nav items skeleton */}
      <div className="py-2 flex flex-col gap-0.5 mx-2">
        <div className="flex items-center gap-2.5 px-3 py-2">
          <Skeleton className="size-3.5 rounded shrink-0" />
          <Skeleton className="h-3.5 w-16" />
        </div>
        <div className="flex items-center gap-2.5 px-3 py-2">
          <Skeleton className="size-3.5 rounded shrink-0" />
          <Skeleton className="h-3.5 w-14" />
        </div>
      </div>

      {/* Task rows skeleton */}
      <div className="flex flex-col gap-1 px-4 pt-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-1.5 py-2">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TasksSidePanel({ virtualMcpId }: { virtualMcpId?: string }) {
  return (
    <ErrorBoundary fallback={<Chat.Skeleton />}>
      <Suspense fallback={<TasksPanelSkeleton />}>
        <TasksPanelContent virtualMcpId={virtualMcpId} />
      </Suspense>
    </ErrorBoundary>
  );
}
