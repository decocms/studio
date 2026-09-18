import type { ReactNode } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { DropdownMenuTrigger } from "@decocms/ui/components/dropdown-menu.tsx";
import { DotsHorizontal } from "@untitledui/icons";
import { useCompactPageLayout } from "@/hooks/use-preferences";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * The one row shape every list in the editor uses — page sections, page
 * variants and section variants. They differ only in tone, so sharing the
 * container and the action trigger keeps a fix in one of them from silently
 * skipping the others.
 */
export type EditorRowTone = "default" | "variant";

const TONE: Record<EditorRowTone, { rest: string; selected: string }> = {
  default: {
    rest: "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
    selected: "bg-accent text-accent-foreground",
  },
  variant: {
    rest: "text-[oklch(0.45_0.15_160)] hover:bg-[oklch(0.65_0.15_160/0.12)] dark:text-[oklch(0.78_0.15_160)] dark:hover:bg-[oklch(0.65_0.15_160/0.15)]",
    selected:
      "text-[oklch(0.45_0.15_160)] bg-[oklch(0.65_0.15_160/0.18)] dark:text-[oklch(0.78_0.15_160)] dark:bg-[oklch(0.65_0.15_160/0.2)]",
  },
};

export function editorRowClassName({
  tone = "default",
  selected = false,
  className,
}: {
  tone?: EditorRowTone;
  selected?: boolean;
  className?: string;
} = {}) {
  return cn(
    "group relative flex touch-none select-none items-center gap-2 rounded-md px-2 py-2.5 transition-colors",
    selected ? TONE[tone].selected : TONE[tone].rest,
    className,
  );
}

/** Faded out at rest and revealed on hover, on keyboard focus, and while its
 *  menu is open. The slot keeps its width throughout: collapsing it would
 *  reflow the row's label on every hover, and would leave the control with no
 *  hit area for pointer or automation until the row happened to be hovered. */
const REVEAL =
  "h-7 w-7 shrink-0 opacity-0 transition-opacity " +
  "group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 data-[state=open]:opacity-100";

/**
 * A toggle that lives on the row, revealed alongside the overflow trigger. The
 * row's own styling reports the state at rest, so the button is an action
 * rather than an indicator and can hide with its neighbours.
 */
export function EditorRowToggle({
  label,
  active,
  onToggle,
  children,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={label}
      aria-pressed={active}
      className={REVEAL}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </Button>
  );
}

/**
 * A row's overflow trigger. `outline` rather than `ghost` so it stays readable
 * against the row's own hover tint, which uses the same accent token a ghost
 * button would.
 */
export function EditorRowActionsTrigger({
  label,
  classicClassName,
}: {
  label: string;
  /** The list's own pre-redesign trigger classes, used as-is in classic. */
  classicClassName?: string;
}) {
  const compact = useCompactPageLayout();
  return (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant={compact ? "outline" : "ghost"}
        size="icon"
        aria-label={label}
        className={cn(compact ? REVEAL : classicClassName)}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DotsHorizontal className="h-3.5 w-3.5" />
      </Button>
    </DropdownMenuTrigger>
  );
}
