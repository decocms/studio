import { ChevronLeft, ChevronRight } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { type Crumb, crumbLabel } from "./schema-form-breadcrumb";

/**
 * Drill-down trail for a `SchemaForm` rendered inside a panel rather than on a
 * page of its own, which is what `BlockBreadcrumbs` (the page header) is for.
 * Without it, opening an array item or a nested object leaves no way back.
 *
 * Renders nothing at the root.
 */
export function InlineBreadcrumb({
  path,
  onNavigate,
  label,
  backTitle,
}: {
  path: readonly Crumb[];
  onNavigate: (next: Crumb[]) => void;
  /** `aria-label` for the nav landmark. */
  label: string;
  /** Tooltip on the "back to the top level" arrow. */
  backTitle: string;
}) {
  if (path.length === 0) return null;

  return (
    <nav
      aria-label={label}
      className="flex min-w-0 items-center gap-1 overflow-hidden text-xs"
    >
      <button
        type="button"
        onClick={() => onNavigate([])}
        className="flex shrink-0 items-center gap-0.5 rounded-[var(--studio-control-radius,var(--radius-md))] px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        title={backTitle}
      >
        <ChevronLeft className="size-3.5" />
      </button>
      {path.map((crumb, index) => {
        const isLast = index === path.length - 1;
        const crumbText = crumbLabel(crumb);
        return (
          <span
            key={`${crumbText}-${index}`}
            className="flex min-w-0 items-center gap-1 overflow-hidden"
          >
            {index > 0 && (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
            )}
            <button
              type="button"
              onClick={() => onNavigate(path.slice(0, index + 1))}
              title={crumbText}
              className={cn(
                "min-w-0 truncate rounded-[var(--studio-control-radius,var(--radius-md))] px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                isLast
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {crumbText}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
