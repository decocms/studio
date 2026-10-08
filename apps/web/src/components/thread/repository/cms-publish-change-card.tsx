/** One changed page, block, or file in the publish list; the list owns selection and the armed discard. */

import { cn } from "@decocms/ui/lib/utils.ts";
import { PublishCardFrame, PublishGhost } from "./cms-publish-frame.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { File06, LayoutAlt01, Trash01 } from "@untitledui/icons";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  publishChangeDigest,
  type PublishChange,
  type PublishChangeStatus,
} from "./publish-change-summary.ts";

/**
 * Stable identity for a card across summary recomputes. Path first: the file
 * path is known from the manifest, while `blockKey` and `name` are derived
 * from content that arrives later — keying on those would remount the card
 * mid-load, dropping the selection and disarming a live discard.
 */
export function changeId(change: PublishChange): string {
  return change.filepaths[0] ?? change.blockKey ?? change.name;
}

function statusLabel(status: PublishChangeStatus, t: TFunction) {
  return status === "new"
    ? t("thread.publishPopover.chipNew")
    : status === "removed"
      ? t("thread.publishPopover.chipRemoved")
      : t("thread.publishPopover.chipEdited");
}

/** Status is carried by the icon color (lime = added); the title names it for
 *  anyone who can't rely on color alone. */
function changeIcon(change: PublishChange, t: TFunction) {
  const Icon = change.kind === "block" ? LayoutAlt01 : File06;
  return (
    <span title={statusLabel(change.status, t)} className="flex shrink-0">
      <Icon
        className={cn(
          "size-4",
          change.status === "new" && "text-brand",
          change.status === "edited" && "text-warning",
          change.status === "removed" && "text-destructive",
        )}
      />
    </span>
  );
}

function changeDetail(change: PublishChange, t: TFunction) {
  if (change.kind === "page") return change.pagePath;
  if (change.kind !== "block") return null;
  return change.isSiteApp
    ? t("thread.publishPopover.siteConfiguration")
    : t("thread.publishPopover.globalSection");
}

/**
 * How much changed, never a list of what. Section display names come from
 * `__resolveType`, so a page of lazy-loaded sections yielded twenty identical
 * "Lazy — Section" rows that pushed the next card off screen. Counts stay one
 * line; the review pane is where names and fields belong.
 */
function changeSubLines(change: PublishChange, t: TFunction): string[] {
  const digest = publishChangeDigest(change);
  if (digest.newPageSections !== null) {
    return [
      digest.newPageSections === 1
        ? t("thread.publishPopover.newPageSectionOne")
        : t("thread.publishPopover.newPageSections", {
            count: digest.newPageSections,
          }),
    ];
  }

  const lines: string[] = [];
  if (digest.sections === 1) {
    lines.push(t("thread.publishPopover.sectionChangedOne"));
  } else if (digest.sections > 1) {
    lines.push(
      t("thread.publishPopover.sectionsChanged", { count: digest.sections }),
    );
  }
  if (digest.fields === 1) {
    lines.push(t("thread.publishPopover.fieldChangedOne"));
  } else if (digest.fields > 1) {
    lines.push(
      t("thread.publishPopover.fieldsChanged", { count: digest.fields }),
    );
  }
  if (digest.settings) {
    lines.push(t("thread.publishPopover.pageSettingsChanged"));
  }
  return lines;
}

interface PublishChangeCardProps {
  change: PublishChange;
  /** File bodies are still loading, so no sub-lines is "not yet", not "none". */
  bodyPending?: boolean;
  /** Selecting a card shows it in the review pane. */
  selected: boolean;
  onSelect: () => void;
  /** Armed = this card shows Cancel/Discard; only one card may be armed. */
  confirming: boolean;
  onConfirmingChange: (confirming: boolean) => void;
  /** Absent when the change cannot be reverted here (a sandbox's committed work). */
  onDiscard?: () => void;
  isPublishing: boolean;
  isDiscarding: boolean;
}

export function PublishChangeCard({
  change,
  bodyPending = false,
  selected,
  onSelect,
  confirming,
  onConfirmingChange,
  onDiscard,
  isPublishing,
  isDiscarding,
}: PublishChangeCardProps) {
  const t = useT();

  const detail = changeDetail(change, t);
  const subLines = changeSubLines(change, t);
  /** Holds the height a sub-line will occupy, so the list does not grow under
   *  the cursor when bodies land. Only `edited` cards gain sub-lines from
   *  bodies — a new page already counts its sections, and new or removed
   *  blocks never have any. */
  const reservesSubLine =
    bodyPending && subLines.length === 0 && change.status === "edited";

  // The whole card is one target; inner controls stop propagation.
  return (
    <PublishCardFrame
      className={cn(
        "cursor-pointer transition-colors hover:bg-accent/50",
        selected && "border-foreground/30 bg-accent hover:bg-accent",
      )}
      data-change-id={changeId(change)}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2.5">
        {changeIcon(change, t)}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-pressed={selected}
        >
          <span className="truncate text-sm font-medium">{change.name}</span>
          {detail ? (
            <span className="truncate text-xs text-muted-foreground">
              {detail}
            </span>
          ) : null}
        </button>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onConfirmingChange(false);
              }}
            >
              {t("thread.publishDialog.cancel")}
            </button>
            <button
              type="button"
              className="text-xs font-medium text-destructive disabled:opacity-50"
              onClick={(e) => {
                e.stopPropagation();
                onConfirmingChange(false);
                onDiscard?.();
              }}
              disabled={isDiscarding}
            >
              {t("thread.publishPopover.discard")}
            </button>
          </div>
        ) : onDiscard ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("thread.publishPopover.discard")}
                  className="flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-50 rounded-lg"
                  onClick={(e) => {
                    e.stopPropagation();
                    onConfirmingChange(true);
                  }}
                  disabled={isPublishing || isDiscarding}
                >
                  <Trash01 className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {t("thread.publishPopover.discard")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {subLines.length > 0 ? (
        <div className="mt-1 space-y-0.5 pl-[26px] text-xs text-muted-foreground">
          {subLines.map((line, lineIndex) => (
            <div key={`${lineIndex}-${line}`} className="truncate">
              {line}
            </div>
          ))}
        </div>
      ) : reservesSubLine ? (
        <div className="mt-1 space-y-0.5 pl-[26px]">
          <PublishGhost className="h-4 w-2/3" />
        </div>
      ) : null}
    </PublishCardFrame>
  );
}
