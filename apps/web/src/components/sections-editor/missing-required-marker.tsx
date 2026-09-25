import { AlertTriangle } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useNewBlocksEditor } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";

/**
 * The single required-field marker used everywhere in the sections editor,
 * shown when a config is missing a required value. New Layout names the
 * problem with a warning glyph; classic keeps the red dot it has always had.
 * Appearance only — every caller passes its own layout via `className`
 * (inline next to a label, or `absolute` in a row corner so it doesn't shift
 * when the row's hover actions expand).
 */
export function MissingRequiredMarker({ className }: { className?: string }) {
  const t = useT();
  const compact = useNewBlocksEditor();

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={t("sectionsEditor.field.missingRequired")}
            className={cn("shrink-0 cursor-help text-destructive", className)}
          >
            <AlertTriangle className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-56">
          {t("sectionsEditor.field.missingRequiredTooltip")}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={t("sectionsEditor.field.missingRequired")}
          className={cn(
            "size-2 shrink-0 cursor-help rounded-full bg-destructive",
            className,
          )}
        />
      </TooltipTrigger>
      <TooltipContent className="max-w-56">
        {t("sectionsEditor.field.missingRequiredTooltip")}
      </TooltipContent>
    </Tooltip>
  );
}
