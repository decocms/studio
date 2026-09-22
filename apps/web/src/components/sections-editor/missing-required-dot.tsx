import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";

/**
 * The single required-field marker used everywhere in the sections editor: a
 * red dot with a hover tooltip, shown when a config is missing a required
 * value. Appearance only — every caller passes its own layout via `className`
 * (inline next to a label, or `absolute` in a row corner so it doesn't shift
 * when the row's hover actions expand).
 */
export function MissingRequiredDot({ className }: { className?: string }) {
  const t = useT();
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
