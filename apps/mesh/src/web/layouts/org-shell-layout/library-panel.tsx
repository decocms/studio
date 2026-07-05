/**
 * Library as a toggleable panel — not a route you navigate away to.
 *
 * The Library used to be a sidebar menu item that swapped the whole route
 * (losing your chat/task context). It's now a toolbar toggle, like Chat: a
 * right-side panel you can reveal on ANY org-shell screen and dismiss without
 * going anywhere. Browse state stays in the URL (`?path=` — the Library's own
 * grammar, route-agnostic via `useSearch({ strict: false })`); the open/closed
 * state is per-user local storage so it survives navigation.
 *
 * The full-page route (`/$org/files`) still exists for deep links and mobile.
 */
import { lazy, Suspense } from "react";
import { Folder, XClose } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Sheet, SheetContent, SheetTitle } from "@deco/ui/components/sheet.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { track } from "@/web/lib/posthog-client";

const Library = lazy(() => import("@/web/layouts/library/index.tsx"));

export function LibraryPanelToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          onClick={() => {
            track("library_panel_toggled", {
              next_state: !open ? "open" : "closed",
            });
            onToggle();
          }}
          aria-pressed={open}
          aria-label="Library"
          active={open}
        >
          <Folder size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">Library</TooltipContent>
    </Tooltip>
  );
}

function PanelFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size="sm" />
    </div>
  );
}

export function LibraryPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
        <SheetContent side="right" className="w-screen max-w-none! p-0">
          <SheetTitle className="sr-only">Library</SheetTitle>
          <div className="h-full overflow-hidden">
            <Suspense fallback={<PanelFallback />}>
              <Library />
            </Suspense>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  if (!open) return null;

  return (
    <aside className="flex h-full w-[min(560px,42vw)] shrink-0 flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="flex items-center gap-2 text-sm font-medium text-sidebar-foreground">
          <Folder size={14} />
          Library
        </span>
        <ToolbarIconButton onClick={onClose} aria-label="Close library">
          <XClose size={16} />
        </ToolbarIconButton>
      </div>
      {/* The Library floats its own card-shadow card and expects the shell's
          cream (bg-sidebar) behind it with a little breathing room on top —
          without it the card's rounded top edge renders clipped/flush. */}
      <div className="min-h-0 flex-1 overflow-hidden pt-0.5">
        <Suspense fallback={<PanelFallback />}>
          <Library />
        </Suspense>
      </div>
    </aside>
  );
}
