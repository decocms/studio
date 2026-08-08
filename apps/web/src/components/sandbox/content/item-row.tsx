import { AlertCircle } from "@untitledui/icons";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { GLOBAL_SECTION_ICON_COLOR } from "@/components/sections-editor/section-types";

export function ItemRow({
  icon: Icon,
  logoUrl,
  title,
  subtitle,
  active,
  accent,
  variantCount,
  trailing,
  selectable,
  selectionActive,
  selected,
  invalid,
  invalidReason,
  onToggleSelect,
  onClick,
  menu,
}: {
  icon: React.ComponentType<{
    size?: number;
    className?: string;
    style?: React.CSSProperties;
  }>;
  logoUrl?: string;
  title: string;
  subtitle: string;
  active: boolean;
  /** "global" tints the row purple to mark a saved/global section. */
  accent?: "global";
  variantCount?: number;
  trailing?: React.ReactNode;
  selectable?: boolean;
  /** In selection mode the checkbox is always shown (not just on hover). */
  selectionActive?: boolean;
  selected?: boolean;
  /** Marks the row as incomplete — tints the title red + shows a warning. */
  invalid?: boolean;
  /** Tooltip on the warning icon, e.g. "Missing: Slug, Excerpt". */
  invalidReason?: string;
  onToggleSelect?: () => void;
  onClick: () => void;
  menu?: React.ReactNode;
}) {
  const isGlobal = accent === "global";
  const rowIcon =
    variantCount && variantCount > 1 ? (
      <span className="flex size-8 shrink-0 items-center justify-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Icon size={16} className="shrink-0 text-success" />
          </TooltipTrigger>
          <TooltipContent side="right">{variantCount} variants</TooltipContent>
        </Tooltip>
      </span>
    ) : logoUrl ? (
      <img
        src={logoUrl}
        alt=""
        className="size-8 shrink-0 rounded-lg object-cover bg-muted"
      />
    ) : (
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          isGlobal ? "bg-global-section/15" : "bg-muted",
        )}
      >
        <Icon
          size={16}
          className={cn(
            "shrink-0",
            !isGlobal &&
              (active ? "text-accent-foreground" : "text-muted-foreground"),
          )}
          style={isGlobal ? { color: GLOBAL_SECTION_ICON_COLOR } : undefined}
        />
      </span>
    );

  return (
    <div
      className={cn(
        "group relative flex min-w-0 items-center rounded-md transition-colors",
        active
          ? isGlobal
            ? "bg-global-section/15 text-global-section-fg dark:text-global-section-fg-dark"
            : "bg-accent text-accent-foreground"
          : isGlobal
            ? "hover:bg-global-section/10"
            : "hover:bg-muted",
      )}
    >
      {selectable && (
        <span
          className={cn(
            "flex shrink-0 items-center pl-2.5 transition-opacity",
            selected || selectionActive
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect?.()}
            aria-label={`Select ${title}`}
          />
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left cursor-pointer"
      >
        {rowIcon}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm font-medium",
              invalid && !active && "text-destructive",
            )}
          >
            {title}
          </span>
          <span
            className={cn(
              "block truncate text-xs",
              active ? "text-accent-foreground/70" : "text-muted-foreground",
            )}
          >
            {subtitle}
          </span>
        </span>
        {invalid && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "flex shrink-0 items-center",
                  active ? "text-accent-foreground" : "text-destructive",
                )}
              >
                <AlertCircle size={14} />
              </span>
            </TooltipTrigger>
            {invalidReason && (
              <TooltipContent side="bottom">{invalidReason}</TooltipContent>
            )}
          </Tooltip>
        )}
        {trailing}
      </button>
      {menu && (
        <div
          className={cn(
            "pr-1 opacity-0 transition-opacity group-hover:opacity-100",
            active && "opacity-100",
          )}
        >
          {menu}
        </div>
      )}
    </div>
  );
}
