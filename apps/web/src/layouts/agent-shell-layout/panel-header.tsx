/**
 * Per-panel header primitives for the desktop workspace.
 *
 * The old shell had ONE 48px toolbar spanning both panels. The rebuild gives
 * every panel (chat, main) its own 48px header whose buttons follow the panel.
 * `PanelHeader` is the shared 48px strip; every control inside is 28px tall to
 * stay fully consistent across panels.
 *
 * Portal targets live in the main panel header:
 *   - `MainPanelHeaderSlot` — the flexible middle region. Preview fills it with
 *     its page selector + controls, so Preview needs no second toolbar (single
 *     top bar in CMS).
 *   - `MainPanelHeaderEndSlot` — the right-side action cluster (before publish).
 *     Preview drops its Blocks toggle + ⋯ menu here.
 *
 * When no provider is present (mobile, where the main panel is full-screen and
 * uses the shared header), `useMainPanelHeaderSlot` returns null and consumers
 * render their controls inline instead.
 */

import {
  createContext,
  use,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * 48px header strip shared by every desktop panel. Sits on the sidebar
 * background above the panel card (no border/divider — the rounded card owns
 * the only visible edge).
 *
 * Declares `@container/panel-header`, the query container every control inside
 * degrades against. It has to be the panel header rather than the viewport:
 * this strip is one panel wide, so the same viewport yields very different
 * header widths depending on whether chat is open and how the splitter sits
 * (at a 1074px viewport the main header measures ~826px). Keying off the
 * viewport made controls collapse at widths that had nothing to do with the
 * room they actually had.
 */
export function PanelHeader({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "@container/panel-header flex h-12 shrink-0 items-center gap-1 px-1.5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type MainPanelHeaderCtx = {
  slotEl: HTMLDivElement | null;
  setSlotEl: (el: HTMLDivElement | null) => void;
  endActionsEl: HTMLDivElement | null;
  setEndActionsEl: (el: HTMLDivElement | null) => void;
};

const MainPanelHeaderContext = createContext<MainPanelHeaderCtx | null>(null);

export function MainPanelHeaderProvider({ children }: { children: ReactNode }) {
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const [endActionsEl, setEndActionsEl] = useState<HTMLDivElement | null>(null);
  return (
    <MainPanelHeaderContext
      value={{
        slotEl,
        setSlotEl,
        endActionsEl,
        setEndActionsEl,
      }}
    >
      {children}
    </MainPanelHeaderContext>
  );
}

/**
 * The centered middle portal target in the main panel header. Preview fills it
 * with its page selector so the URL group sits centered over the page.
 */
export function MainPanelHeaderSlot({ className }: { className?: string }) {
  const ctx = use(MainPanelHeaderContext);
  return (
    <div
      ref={ctx?.setSlotEl}
      className={cn("flex min-w-0 items-center", className)}
    />
  );
}

/** Right-side portal target, before the publish actions (e.g. Preview's ⋯). */
export function MainPanelHeaderEndSlot() {
  const ctx = use(MainPanelHeaderContext);
  return <div ref={ctx?.setEndActionsEl} className="contents" />;
}

/**
 * Portal `children` into the main panel header slot. Returns `null` when the
 * slot node isn't mounted yet; consumers that need an inline fallback should
 * read `useMainPanelHeaderSlot()` directly.
 */
export function MainPanelHeaderPortal({ children }: { children: ReactNode }) {
  const ctx = use(MainPanelHeaderContext);
  if (!ctx?.slotEl) return null;
  return createPortal(children, ctx.slotEl);
}

/** Portal `children` into the right-side actions slot (e.g. Preview's ⋯). */
export function MainPanelHeaderEndPortal({
  children,
}: {
  children: ReactNode;
}) {
  const ctx = use(MainPanelHeaderContext);
  if (!ctx?.endActionsEl) return null;
  return createPortal(children, ctx.endActionsEl);
}

/**
 * Returns the main panel header slot node, or null when there is no header
 * (mobile / standalone surfaces). Lets a consumer decide between portaling into
 * the shared header and rendering its controls inline.
 */
export function useMainPanelHeaderSlot(): HTMLDivElement | null {
  return use(MainPanelHeaderContext)?.slotEl ?? null;
}
