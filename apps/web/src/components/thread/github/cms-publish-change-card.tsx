/**
 * One changed page, block, or file as a card: what it is, what changed under
 * it, and — once expanded — the raw diff. Expansion and the armed discard
 * confirmation are both exclusive across the list, so the popover owns both
 * and drives them through props.
 */

import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ChevronRight, File06, LayoutAlt01, Trash01 } from "@untitledui/icons";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { GitDiffList } from "./git-diff-list.tsx";
import {
  countPageSections,
  type PublishChange,
  type PublishChangeStatus,
} from "./publish-change-summary.ts";
import type { GitDiffResult } from "./sandbox-git-api.ts";

/** Stable identity for a card across summary recomputes. */
export function changeId(change: PublishChange): string {
  return change.blockKey ?? change.filepaths[0] ?? change.name;
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

/** A new page is summarized by its size; everything else by what it touched. */
function changeSubLines(change: PublishChange, t: TFunction): string[] {
  if (change.kind === "page" && change.status === "new") {
    return [
      t("thread.publishPopover.newPageSections", {
        count: countPageSections(change.toJson),
      }),
    ];
  }
  return change.sections.map((section) =>
    section.fields.length > 0
      ? `${section.name} — ${section.fields
          .slice(0, 4)
          .map((f) => f.label)
          .join(", ")}`
      : section.name,
  );
}

interface PublishChangeCardProps {
  change: PublishChange;
  /** The whole publish diff; the card slices out its own files. */
  diff: GitDiffResult | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Armed = this card shows Cancel/Discard; only one card may be armed. */
  confirming: boolean;
  onConfirmingChange: (confirming: boolean) => void;
  onDiscard: () => void;
  isPublishing: boolean;
  isDiscarding: boolean;
}

export function PublishChangeCard({
  change,
  diff,
  expanded,
  onToggleExpanded,
  confirming,
  onConfirmingChange,
  onDiscard,
  isPublishing,
  isDiscarding,
}: PublishChangeCardProps) {
  const t = useT();

  const detail = changeDetail(change, t);
  const subLines = changeSubLines(change, t);
  const rawDiff: GitDiffResult = {
    diffs: Object.fromEntries(
      change.filepaths.flatMap((p) => {
        const entry = diff?.diffs[p];
        return entry ? [[p, entry] as const] : [];
      }),
    ),
  };
  const canExpand = Object.keys(rawDiff.diffs).length > 0;

  // Collapsed card = one big expand target; inner controls stop propagation.
  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-3 py-2.5",
        canExpand && !expanded && "cursor-pointer",
      )}
      data-change-id={changeId(change)}
      onClick={canExpand && !expanded ? onToggleExpanded : undefined}
    >
      <div
        className={cn(
          "flex items-center gap-2.5",
          canExpand && "cursor-pointer",
        )}
        onClick={
          canExpand
            ? (e) => {
                e.stopPropagation();
                onToggleExpanded();
              }
            : undefined
        }
      >
        {changeIcon(change, t)}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          disabled={!canExpand}
          aria-expanded={canExpand ? expanded : undefined}
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
                onDiscard();
              }}
              disabled={isDiscarding}
            >
              {t("thread.publishPopover.discard")}
            </button>
          </div>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("thread.publishPopover.discard")}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-50"
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
        )}
        {canExpand ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        ) : null}
      </div>
      {!expanded && subLines.length > 0 ? (
        <div className="mt-1 space-y-0.5 pl-[26px] text-xs text-muted-foreground">
          {subLines.map((line, lineIndex) => (
            <div key={`${lineIndex}-${line}`} className="truncate">
              {line}
            </div>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <div className="-mx-3 mt-2 border-t pt-1">
          <div className="scroll-fade max-h-72 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
            <GitDiffList diff={rawDiff} hideFileRows editorHeight="220px" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
