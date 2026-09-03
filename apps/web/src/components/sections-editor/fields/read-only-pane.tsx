import type { ReactNode } from "react";
import { Plus } from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { useCreateDraft } from "@/components/thread/github/use-version-gate";
import { useT } from "@/i18n/use-t.ts";
import {
  ReadOnlyProvider,
  ReadOnlyVirtualMcpProvider,
  useReadOnlyVirtualMcpId,
} from "./read-only-context";

/**
 * Drop-in replacement for a panel's wrapper `<div>` that also publishes the
 * read-only state to every descendant form widget via {@link ReadOnlyProvider}.
 * Swapping `<div className=…>` → `<ReadOnlyPane className=… readOnly=…>` keeps
 * the children at the same nesting depth (no reindent) and adds no layout box
 * beyond the div — the provider is DOM-transparent. `virtualMcpId` lets a
 * blocked control offer "start a new draft" (see {@link ReadOnlyEditPopover}).
 */
export function ReadOnlyPane({
  readOnly,
  virtualMcpId,
  className,
  children,
}: {
  readOnly: boolean;
  virtualMcpId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <ReadOnlyVirtualMcpProvider value={virtualMcpId}>
        <ReadOnlyProvider value={readOnly}>{children}</ReadOnlyProvider>
      </ReadOnlyVirtualMcpProvider>
    </div>
  );
}

/**
 * "Start a new draft" action shown inside the read-only popover. Kept in its own
 * component so {@link useCreateDraft} only runs when the popover is open (Radix
 * mounts content on demand) rather than once per blocked control.
 */
function StartDraftButton({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const createDraft = useCreateDraft(virtualMcpId);
  return (
    <button
      type="button"
      onClick={() => void createDraft()}
      className="inline-flex items-center gap-1.5 self-start rounded-md bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-background/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-foreground"
    >
      <Plus size={14} className="shrink-0" />
      {t("thread.branchPicker.newVersion")}
    </button>
  );
}

/**
 * The tooltip-styled popover body shown when an edit is blocked on production:
 * a "production is read-only" line plus a "start a new draft" button. Rendered
 * inside a {@link Popover} — either the trigger form ({@link ReadOnlyEditPopover})
 * or a controlled/anchored one (e.g. a blocked drag gesture).
 */
export function ReadOnlyEditPopoverContent() {
  const t = useT();
  const virtualMcpId = useReadOnlyVirtualMcpId();
  return (
    <PopoverContent
      align="center"
      className="flex w-fit max-w-[260px] flex-col gap-2.5 border-transparent bg-foreground p-3 text-background"
    >
      <p className="text-xs text-balance">
        {t("sectionsEditor.readOnlyFieldTooltip")}
      </p>
      {virtualMcpId ? <StartDraftButton virtualMcpId={virtualMcpId} /> : null}
    </PopoverContent>
  );
}

/**
 * Wraps any control whose action is blocked on production so clicking it opens
 * the read-only popover instead. `children` is the clickable trigger.
 */
export function ReadOnlyEditPopover({ children }: { children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <ReadOnlyEditPopoverContent />
    </Popover>
  );
}

/**
 * Wraps a single leaf value widget as read-only: a real (layout-preserving) box
 * so the form's `space-y` still applies, dimmed for a distinct look, made inert
 * so nothing edits, with a transparent overlay that opens the read-only popover.
 */
export function ReadOnlyFieldWrap({ children }: { children: ReactNode }) {
  return (
    <ReadOnlyEditPopover>
      <div className="relative opacity-70">
        <div inert>{children}</div>
        <div className="absolute inset-0 cursor-pointer" />
      </div>
    </ReadOnlyEditPopover>
  );
}
