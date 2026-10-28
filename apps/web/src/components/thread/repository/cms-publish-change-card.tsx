/** One changed page, block, or file in the publish list; the list owns selection and the armed discard. */

import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { PublishCardFrame, PublishGhost } from "./cms-publish-frame.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { File06, LayoutAlt01, Trash01 } from "@untitledui/icons";
import { useT, type TFunction, type TranslationKey } from "@/i18n/use-t.ts";
import { namedRuleUsePlaces } from "@/components/sections-editor/named-rule-use-copy.ts";
import { blogKindWord } from "@/components/sections-editor/blog-block-name.ts";
import {
  namedRuleBlockOfChange,
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

/**
 * The A/B tests or Campaigns card's line: the verb follows how many places,
 * the noun how many distinct names are missing ("2 pages use a test", "1
 * page uses tests").
 */
function missingUsesKey(
  uses: NonNullable<PublishChange["missingRuleUses"]>,
): TranslationKey {
  const onePlace = uses.pages + uses.sections === 1;
  const oneName = uses.names === 1;
  if (uses.kind === "experiments") {
    return oneName
      ? onePlace
        ? "thread.publishPopover.missingTestUsesOne"
        : "thread.publishPopover.missingTestUses"
      : onePlace
        ? "thread.publishPopover.missingTestsUsesOne"
        : "thread.publishPopover.missingTestsUses";
  }
  return oneName
    ? onePlace
      ? "thread.publishPopover.missingCampaignUsesOne"
      : "thread.publishPopover.missingCampaignUses"
    : onePlace
      ? "thread.publishPopover.missingCampaignsUsesOne"
      : "thread.publishPopover.missingCampaignsUses";
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
  if (change.blogKind) return blogKindWord(change.blogKind, t);
  if (change.cmsSettings) return t("thread.publishPopover.settingsDetail");
  const named = namedRuleBlockOfChange(change);
  if (named === "experiments") return t("thread.publishPopover.abTests");
  if (named === "campaigns") return t("thread.publishPopover.campaignDates");
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
function changeSubLines(
  change: PublishChange,
  t: TFunction,
  v8: boolean,
): string[] {
  const digest = publishChangeDigest(change, v8);
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
  /** A Blocks v8 site's change (`publishChangeDigest`). Absent on v7. */
  v8?: boolean;
  /** Hosted v8: a developer also changed it on main; Publish keeps this one. */
  alsoChangedOnMain?: boolean;
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
  v8 = false,
  alsoChangedOnMain = false,
}: PublishChangeCardProps) {
  const t = useT();

  const detail = changeDetail(change, t);
  const subLines = changeSubLines(change, t, v8);
  const missing = change.missingRules ?? [];
  const missingUses = change.missingRuleUses;
  const missingPlaces = missingUses ? namedRuleUsePlaces(t, missingUses) : null;
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
        "cursor-pointer transition-colors hover:bg-accent",
        selected && "border-foreground/30 bg-accent hover:bg-secondary-hover",
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
          <span className="truncate text-sm font-medium">
            {change.cmsSettings
              ? t("thread.publishPopover.settings")
              : change.name}
          </span>
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
                <Button
                  type="button"
                  variant="ghost-destructive"
                  size="icon-xs"
                  aria-label={t("thread.publishPopover.discard")}
                  // Swallow the click while disabled, or it selects the card underneath.
                  className="shrink-0 disabled:pointer-events-auto"
                  onClick={(e) => {
                    e.stopPropagation();
                    onConfirmingChange(true);
                  }}
                  disabled={isPublishing || isDiscarding}
                >
                  <Trash01 className="size-3.5" />
                </Button>
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
      {missing.length > 0 ? (
        <div
          className="mt-1 space-y-0.5 pl-[26px] text-xs text-foreground"
          data-testid="publish-change-missing-rule"
        >
          {missing.map((kind) => (
            <div key={kind} className="truncate">
              {kind === "experiments"
                ? t("thread.publishPopover.missingTest")
                : t("thread.publishPopover.missingCampaign")}
            </div>
          ))}
        </div>
      ) : null}
      {missingUses && missingPlaces ? (
        <div
          className="mt-1 truncate pl-[26px] text-xs text-foreground"
          data-testid="publish-change-missing-rule-uses"
        >
          {t(missingUsesKey(missingUses), { places: missingPlaces.places })}
        </div>
      ) : null}
      {alsoChangedOnMain ? (
        <div
          className="mt-1 pl-[26px] text-xs text-muted-foreground"
          data-testid="publish-change-also-changed"
        >
          {t("thread.publishPopover.alsoChangedOnMain", { name: change.name })}
        </div>
      ) : null}
    </PublishCardFrame>
  );
}
