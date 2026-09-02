import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useT } from "@/i18n/use-t.ts";
import { ReadOnlyProvider } from "./read-only-context";

/**
 * Drop-in replacement for a panel's wrapper `<div>` that also publishes the
 * read-only state to every descendant form widget via {@link ReadOnlyProvider}.
 * Swapping `<div className=…>` → `<ReadOnlyPane className=… readOnly=…>` keeps
 * the children at the same nesting depth (no reindent) and adds no layout box
 * beyond the div — the provider is DOM-transparent.
 */
export function ReadOnlyPane({
  readOnly,
  className,
  children,
}: {
  readOnly: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <ReadOnlyProvider value={readOnly}>{children}</ReadOnlyProvider>
    </div>
  );
}

/**
 * Wraps a single leaf value widget as read-only: a real (layout-preserving) box
 * so the form's `space-y` still applies, dimmed for a distinct look, made inert
 * so nothing edits, with a transparent overlay that captures hover to surface a
 * "production is read-only" tooltip.
 */
export function ReadOnlyFieldWrap({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative opacity-70">
          <div inert>{children}</div>
          <div className="absolute inset-0 cursor-not-allowed" />
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[240px]">
        {t("sectionsEditor.readOnlyFieldTooltip")}
      </TooltipContent>
    </Tooltip>
  );
}
