/**
 * The inbox: a popover beside the settings gear listing updates on the tasks
 * you follow. Selecting one opens its card.
 *
 * Opening the popover does NOT clear the dot — a glance isn't reading. Marking
 * read is its own action, so an update you saw but didn't act on survives.
 *
 * Updates are sample data for now (see `use-inbox-feed.ts`); this file is the
 * finished surface.
 */

import { type ReactNode, useState } from "react";
import { Inbox01 } from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  SidebarMenuButton,
  useSidebar,
} from "@decocms/ui/components/sidebar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { useNavigate } from "@tanstack/react-router";
import { useInboxFeed } from "@/hooks/use-inbox-feed";
import { useProjectContext } from "@/sdk";
import { taskKey } from "@decocms/shared/task-key";
import { useT } from "@/i18n/use-t.ts";
import { InboxTaskItem } from "./inbox-task-item";

function InboxPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { updates, markAllRead } = useInboxFeed();

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium">{t("sidebar.inbox.title")}</h3>
        {updates.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={markAllRead}
          >
            {t("sidebar.inbox.markAllRead")}
          </Button>
        )}
      </div>
      {updates.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Inbox01 size={24} className="text-muted-foreground/50" />
          <p className="text-sm font-medium text-foreground">
            {t("sidebar.inbox.emptyTitle")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("sidebar.inbox.emptyBody")}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {updates.map((update) => {
            const key = taskKey(org.slug, update.taskKeySeq);
            return (
              <InboxTaskItem
                key={update.id}
                update={update}
                orgSlug={org.slug}
                onSelect={() => {
                  onClose();
                  if (key) {
                    navigate({
                      to: "/$org/t/$taskKey",
                      params: { org: org.slug, taskKey: key },
                    });
                  }
                }}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function InboxDot() {
  const { redDotCount } = useInboxFeed();
  if (redDotCount === 0) return null;
  return (
    <span className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-destructive" />
  );
}

function InboxPopover({
  open,
  onOpenChange,
  side,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "right" | "top";
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {children}
      <PopoverContent
        side={side}
        align="end"
        sideOffset={12}
        collisionPadding={16}
        className="flex max-h-[min(650px,calc(100dvh-4rem))] w-[min(400px,calc(100vw-2rem))] flex-col p-0"
      >
        {open && <InboxPanel onClose={() => onOpenChange(false)} />}
      </PopoverContent>
    </Popover>
  );
}

/** Icon-only trigger, sized to sit beside the settings gear. */
export function InboxIconButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <InboxPopover open={open} onOpenChange={setOpen} side="top">
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("sidebar.inbox.title")}
          className="relative flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Inbox01 size={15} />
          <InboxDot />
        </button>
      </PopoverTrigger>
    </InboxPopover>
  );
}

/** Full-width row, for the collapsed rail where there's no gear to sit beside. */
export function InboxFullButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { state } = useSidebar();
  return (
    <InboxPopover open={open} onOpenChange={setOpen} side="right">
      <PopoverTrigger asChild>
        <SidebarMenuButton
          tooltip={state === "collapsed" ? t("sidebar.inbox.title") : undefined}
          className="relative"
        >
          <Inbox01 />
          {/* Before the label: the collapsed rail hides `span:last-child`. */}
          <InboxDot />
          <span className="truncate">{t("sidebar.inbox.title")}</span>
        </SidebarMenuButton>
      </PopoverTrigger>
    </InboxPopover>
  );
}
