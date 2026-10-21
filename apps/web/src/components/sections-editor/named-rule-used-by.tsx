import { ArrowUpRight, File02, LayoutAlt01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { NamedRuleKind } from "./named-rules";
import type { NamedRuleUseRow } from "./named-rule-uses";

/**
 * "Used by" for a test or a campaign: the pages and sections whose variants
 * name it in the draft, with the ones not published yet (or removed in the
 * draft) marked, and the sections that read every name in their own code.
 * Each opens in the site editor.
 */
export function NamedRuleUsedBy({
  kind,
  rows,
  wholeRows,
  loading,
  marked,
  onOpen,
}: {
  kind: NamedRuleKind;
  rows: NamedRuleUseRow[];
  wholeRows: NamedRuleUseRow[];
  /** The draft isn't read yet. */
  loading?: boolean;
  /** Whether the rows' published marks are known (else none is shown). */
  marked: boolean;
  onOpen?: (row: NamedRuleUseRow) => void;
}) {
  const t = useT();
  const tests = kind === "experiments";
  return (
    <section className="flex flex-col gap-2" data-testid="named-rule-used-by">
      <h3 className="text-sm font-medium">
        {t("sectionsEditor.namedRuleUses.title")}
      </h3>
      {loading ? (
        <p className="text-sm text-muted-foreground">
          {t("sectionsEditor.namedRuleUses.loading")}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tests
            ? t("sectionsEditor.namedRuleUses.emptyTests")
            : t("sectionsEditor.namedRuleUses.emptyCampaigns")}
        </p>
      ) : (
        <NamedRuleUseList rows={rows} marked={marked} onOpen={onOpen} />
      )}
      {wholeRows.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">
            {tests
              ? t("sectionsEditor.namedRuleUses.wholeTests")
              : t("sectionsEditor.namedRuleUses.wholeCampaigns")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {tests
              ? t("sectionsEditor.namedRuleUses.wholeTestsHint")
              : t("sectionsEditor.namedRuleUses.wholeCampaignsHint")}
          </p>
          <NamedRuleUseList rows={wholeRows} marked={marked} onOpen={onOpen} />
        </div>
      )}
    </section>
  );
}

/** The rows of "Used by", each with an Open button (removed uses have none). */
export function NamedRuleUseList({
  rows,
  marked,
  onOpen,
}: {
  rows: NamedRuleUseRow[];
  marked: boolean;
  onOpen?: (row: NamedRuleUseRow) => void;
}) {
  const t = useT();
  return (
    <ul className="divide-y divide-border/60 rounded-md border border-border/60">
      {rows.map((row) => {
        const Icon = row.blockKind === "page" ? LayoutAlt01 : File02;
        const removed = row.state === "removed-in-draft";
        return (
          <li
            key={`${row.blockKey}#${row.variant ?? ""}#${row.wholeBlock}`}
            className="flex items-center gap-3 px-3 py-2"
            data-use-state={row.state}
          >
            <Icon size={14} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "truncate text-sm",
                  removed && "text-muted-foreground line-through",
                )}
              >
                {row.title}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {[
                  row.path,
                  row.variant
                    ? t("sectionsEditor.namedRuleUses.variant", {
                        index: String(row.variant),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {marked && row.state === "draft-only" && (
              <Badge variant="muted">
                {t("sectionsEditor.namedRuleUses.draftOnly")}
              </Badge>
            )}
            {marked && removed && (
              <Badge variant="muted">
                {t("sectionsEditor.namedRuleUses.removed")}
              </Badge>
            )}
            {onOpen && !removed && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpen(row)}
              >
                {t("sectionsEditor.namedRuleUses.open")}
                <ArrowUpRight size={14} />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
