import SlideHeader from "./slide-header";
import TableTemplate from "./table-template";
import { DECK } from "./tokens";
import { useT } from "@/i18n/use-t.ts";
import type { TableProps } from "@decocms/shared/reports/deck-types";

// Severity chips are graded by the engine's badge LABEL — the badge tone alone
// can't tell "Atenção" from "Menor" (both arrive `neutral`). The label is
// client copy, so it arrives translated on a non-pt deck: key both languages.
const CRITICAL = { color: "#ef4444", tint: "rgba(239,68,68,0.12)" };
const WARNING = { color: "#d98324", tint: "rgba(217,131,36,0.12)" };
const SEVERITY_STYLE: Record<string, { color: string; tint: string }> = {
  Crítico: CRITICAL,
  Critical: CRITICAL,
  Atenção: WARNING,
  Warning: WARNING,
};
const SEVERITY_FALLBACK = { color: DECK.muted, tint: "rgba(13,9,6,0.06)" };

interface PageIssue {
  title: string;
  severity: string;
}
interface PageGroup {
  page: string;
  issues: PageIssue[];
}

/** Fold the engine's flat [página, "✗ verificação", badge] rows into per-page
 *  groups (engine order preserved). Returns null when any row deviates from
 *  that shape — the caller falls back to the generic table. */
function groupRows(rows: TableProps["rows"]): PageGroup[] | null {
  const groups: PageGroup[] = [];
  for (const row of rows) {
    const [page, check, badge] = row;
    if (
      row.length !== 3 ||
      page?.kind !== "text" ||
      check?.kind !== "text" ||
      badge?.kind !== "badge"
    )
      return null;
    const issue: PageIssue = {
      title: check.value.replace(/^✗\s*/, ""),
      severity: badge.label,
    };
    const last = groups[groups.length - 1];
    if (last && last.page === page.value) last.issues.push(issue);
    else groups.push({ page: page.value, issues: [issue] });
  }
  return groups.length > 0 ? groups : null;
}

function SeverityPill({ severity }: { severity: string }) {
  const sev = SEVERITY_STYLE[severity] ?? SEVERITY_FALLBACK;
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium leading-[1.4] sm:text-[11px]"
      style={{ color: sev.color, background: sev.tint }}
    >
      {severity}
    </span>
  );
}

function Cross({ severity }: { severity: string }) {
  const sev = SEVERITY_STYLE[severity] ?? SEVERITY_FALLBACK;
  return (
    <span
      className="shrink-0 text-sm font-semibold leading-snug sm:text-base"
      style={{ color: sev.color }}
    >
      ✗
    </span>
  );
}

/**
 * Keyed variant for the engine's deterministic "Problemas por página" slide
 * (up to 8 failed checks). The flat 3-column table read like a spreadsheet.
 * Mobile renders a compact single-card ledger. sm+ renders one CARD PER ISSUE
 * in a responsive grid so the slide fills the width no matter how the engine
 * buckets pages — in practice it often returns every check under a single
 * "Todas as páginas" group, which a card-per-PAGE grid collapsed into one
 * lonely card stranded top-left. The page name rides each card as a caption,
 * but only when there's genuinely more than one page (repeating a single
 * generic bucket 8× is just noise). Same data, no contract change.
 */
export default function PaginasVariant(props: TableProps) {
  const t = useT();
  const { eyebrow, headline, annotation, rows, active } = props;
  const groups = groupRows(rows);
  if (!groups) return <TableTemplate {...props} />;

  // Flatten to per-issue cards (engine order preserved). Show the page caption
  // only when the journey actually spans more than one page.
  const showPage = groups.length > 1;
  const issues = groups.flatMap((group) =>
    group.issues.map((issue) => ({ ...issue, page: group.page })),
  );

  let mobileIndex = 0;
  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-2 sm:px-10 sm:py-4 lg:px-16">
        {/* mobile — one compact ledger card (a 390px row IS a card-width row) */}
        <div
          className="reveal my-auto w-full rounded-2xl px-3.5 py-1 sm:hidden"
          data-show={active ? "true" : "false"}
          style={{
            background: DECK.surface,
            border: `1px solid ${DECK.border}`,
            transitionDelay: active ? "80ms" : "0ms",
          }}
        >
          {groups.map((group, gi) => (
            <div
              key={gi}
              className="py-[min(0.625rem,1.2svh)]"
              style={{
                borderTop: gi > 0 ? `1px solid ${DECK.border}` : undefined,
              }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: DECK.muted }}
                >
                  {group.page}
                </span>
                {group.issues.length > 1 && (
                  <span
                    className="text-[11px] tabular-nums"
                    style={{ color: DECK.muted, opacity: 0.7 }}
                  >
                    {group.issues.length} {t("reports.paginasVariant.found")}
                  </span>
                )}
              </div>
              {group.issues.map((issue, ii) => {
                const delay = 140 + mobileIndex++ * 60;
                return (
                  <div
                    key={ii}
                    className="reveal mt-[min(0.375rem,0.8svh)] flex items-baseline gap-2"
                    data-show={active ? "true" : "false"}
                    style={{ transitionDelay: active ? `${delay}ms` : "0ms" }}
                  >
                    <Cross severity={issue.severity} />
                    <span
                      className="min-w-0 flex-1 line-clamp-2 text-[13px] font-medium leading-snug tracking-[-0.01em]"
                      style={{ color: DECK.ink }}
                    >
                      {issue.title}
                    </span>
                    <SeverityPill severity={issue.severity} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* sm+ — one card per ISSUE in a responsive grid, so the slide fills
            the width whether the engine returns 7 pages or one bucket. */}
        <div className="my-auto hidden w-full gap-4 sm:grid sm:grid-cols-2 lg:grid-cols-3">
          {issues.map((issue, i) => (
            <div
              key={i}
              className="reveal flex flex-col gap-3 rounded-2xl px-5 py-4"
              data-show={active ? "true" : "false"}
              style={{
                background: DECK.surface,
                border: `1px solid ${DECK.border}`,
                transitionDelay: active ? `${100 + i * 60}ms` : "0ms",
              }}
            >
              {showPage && (
                <span
                  className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: DECK.muted }}
                >
                  {issue.page}
                </span>
              )}
              <div className="flex items-start gap-2.5">
                <Cross severity={issue.severity} />
                <span
                  className="min-w-0 flex-1 text-sm font-medium leading-snug tracking-[-0.01em] lg:text-[15px]"
                  style={{ color: DECK.ink }}
                >
                  {issue.title}
                </span>
              </div>
              <div className="mt-auto">
                <SeverityPill severity={issue.severity} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
