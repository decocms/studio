import { Zap } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ResponsiveImageField } from "@/components/sections-editor/fields/responsive-image-field";
import { ToolbarButton } from "@/components/sections-editor/toolbar-button";
import { useT } from "@/i18n/use-t";
import { InlineText, str } from "./primitives";

/**
 * The post body's image block, edited in place. The desktop/mobile preview,
 * the URL field and the quality control come from {@link ResponsiveImageField},
 * shared with the post cover; this adds the two props only a body
 * image has — its `normal`/`full` width and the fetch-priority flag — plus
 * the caption and alt lines.
 */
export function BlockImageBlock({
  block,
  onChange,
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const t = useT();
  const size = str(block.size) || "normal";

  return (
    <div className="space-y-2">
      <ResponsiveImageField
        value={block.url}
        mobileValue={block.mobileUrl}
        onChange={(v) => onChange({ ...block, url: v })}
        onMobileChange={(v) => onChange({ ...block, mobileUrl: v })}
        alt={str(block.alt)}
        toolbarExtras={
          <>
            {(["normal", "full"] as const).map((option) => (
              <ToolbarButton
                key={option}
                active={size === option}
                label={option}
                onClick={() => onChange({ ...block, size: option })}
              >
                <span className="px-0.5 text-xs">
                  {option === "full"
                    ? t("sandbox.mediaBlocks.fullWidth")
                    : t("sandbox.mediaBlocks.normal")}
                </span>
              </ToolbarButton>
            ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <ToolbarButton
                    active={block.highPriority === true}
                    label={t("sandbox.mediaBlocks.highPriority")}
                    onClick={() =>
                      onChange({
                        ...block,
                        highPriority: block.highPriority ? undefined : true,
                      })
                    }
                  >
                    <Zap size={14} />
                  </ToolbarButton>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                {t("sandbox.mediaBlocks.highPriorityHint")}
              </TooltipContent>
            </Tooltip>
          </>
        }
      />

      {/* The caption the site renders under the image. */}
      <InlineText
        value={str(block.caption)}
        onChange={(v) => onChange({ ...block, caption: v })}
        placeholder={t("sandbox.mediaBlocks.addCaption")}
        className="text-center text-sm italic text-muted-foreground"
      />

      {/* Alt stays plain text: it is prose, it may wrap, and it is never
          shown on the site. */}
      <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 font-medium">
          {t("sandbox.mediaBlocks.altLabel")}
        </span>
        <InlineText
          value={str(block.alt)}
          onChange={(v) => onChange({ ...block, alt: v })}
          placeholder={t("sandbox.mediaBlocks.altText")}
          className="text-xs"
        />
      </div>
    </div>
  );
}
