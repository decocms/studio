import { cn } from "@deco/ui/lib/utils.ts";
import SlideHeader from "./slide-header";
import { DECK, TONE_COLOR } from "./tokens";
import type {
  BadgeCell,
  NumberCell,
  ScoreCell,
  SparklineCell,
  TableCell,
  TableProps,
  TextCell,
  Tone,
} from "@decocms/shared/reports/deck-types";

const DELTA_COLOR: Record<"up" | "down" | "neutral", string> = {
  up: TONE_COLOR.good,
  down: TONE_COLOR.bad,
  neutral: DECK.muted,
};

const DELTA_ARROW: Record<"up" | "down" | "neutral", string> = {
  up: "↑",
  down: "↓",
  neutral: "→",
};

function toneColor(tone?: Tone, muted?: boolean) {
  if (tone) return TONE_COLOR[tone];
  if (muted) return DECK.muted;
  return DECK.ink;
}

function CellText({ cell }: { cell: TextCell }) {
  // Clamp to 2 lines so a long value (e.g. a product name) never balloons a row
  // to 5 lines on a phone — the main thing that made the table "look ass" there.
  return (
    <span
      className="line-clamp-2 leading-snug"
      style={{ color: toneColor(cell.tone, cell.muted) }}
    >
      {cell.value}
    </span>
  );
}

function CellNumber({ cell }: { cell: NumberCell }) {
  const dir = cell.deltaDir ?? "neutral";
  return (
    <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
      <span style={{ color: toneColor(cell.tone, cell.muted) }}>
        {cell.value}
      </span>
      {cell.delta && (
        <span
          className="text-sm tabular-nums"
          style={{ color: DELTA_COLOR[dir] }}
        >
          {DELTA_ARROW[dir]} {cell.delta}
        </span>
      )}
    </span>
  );
}

function CellSparkline({ cell }: { cell: SparklineCell }) {
  const color = cell.tone ? TONE_COLOR[cell.tone] : DECK.muted;
  const W = 48;
  const H = 20;
  const n = cell.points.length;
  if (n < 2) return null;

  const step = W / (n - 1);
  const pts = cell.points.map((v, i) => `${i * step},${H - v * H}`).join(" ");

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="inline-block align-middle"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CellBadge({ cell }: { cell: BadgeCell }) {
  const color = cell.tone ? TONE_COLOR[cell.tone] : DECK.muted;
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color, border: `1px solid ${color}`, lineHeight: "1.4" }}
    >
      {cell.label}
    </span>
  );
}

function CellScore({ cell }: { cell: ScoreCell }) {
  const color = cell.tone ? TONE_COLOR[cell.tone] : DECK.ink;
  const pct = Math.min(100, Math.max(0, cell.value));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-sm tabular-nums" style={{ color }}>
        {pct}
      </span>
      <span
        className="inline-block h-1.5 w-12 overflow-hidden rounded-full"
        style={{ background: DECK.border }}
      >
        <span
          className="block h-full rounded-full"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
    </span>
  );
}

function RenderCell({ cell }: { cell: TableCell }) {
  switch (cell.kind) {
    case "text":
      return <CellText cell={cell} />;
    case "number":
      return <CellNumber cell={cell} />;
    case "sparkline":
      return <CellSparkline cell={cell} />;
    case "badge":
      return <CellBadge cell={cell} />;
    case "score":
      return <CellScore cell={cell} />;
    default:
      return cell satisfies never;
  }
}

/**
 * A data table — ranked rows of rich cells. Each cell declares its own `kind`
 * (text · number · sparkline · badge · score) so columns can mix display styles.
 */
export default function TableTemplate({
  eyebrow,
  headline,
  annotation,
  columns,
  rows,
  highlightRow,
  active,
}: TableProps) {
  // Cell padding below was tuned for short ranked lists; the issues-by-page
  // rollup ships up to 8 rows, which overflowed the slide on mobile (the
  // centered table clipped at BOTH ends with no scroll). 6+ rows tighten the
  // cells, and the wrapper scrolls vertically as a last resort instead of
  // clipping (`my-auto` keeps short tables centered — `items-center` on the
  // parent would cut off the top of an overflowing one).
  const dense = rows.length >= 6;
  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col px-5 pt-3 sm:items-center sm:justify-center sm:px-10 sm:pt-4 lg:px-16">
        {/* ── Mobile: a horizontal table cramps 4 columns into 390px and clips
            the last one. Instead, stack each row as a card — the first cell is
            the title, the rest become label→value pairs. Scrolls vertically
            inside the slide (absorbsScroll hands the swipe to this list). ── */}
        <ul
          className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto py-1 sm:hidden"
          style={{
            WebkitMaskImage:
              "linear-gradient(to bottom, #000 calc(100% - 20px), transparent 100%)",
            maskImage:
              "linear-gradient(to bottom, #000 calc(100% - 20px), transparent 100%)",
          }}
        >
          {rows.map((row, ri) => (
            <li
              key={ri}
              className="reveal shrink-0 rounded-xl border p-3.5"
              data-show={active ? "true" : "false"}
              style={{
                borderColor: DECK.cardBorder,
                background:
                  ri === highlightRow ? "rgba(40,37,36,0.03)" : DECK.surface,
                transitionDelay: active ? `${80 + ri * 45}ms` : "0ms",
              }}
            >
              <div
                className="text-[15px] font-medium leading-snug"
                style={{ color: DECK.ink }}
              >
                {row[0] && <RenderCell cell={row[0]} />}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-2">
                {row.slice(1).map((cell, ci) => (
                  <div key={ci} className="flex flex-col gap-0.5">
                    <span
                      className="text-[10px] font-medium uppercase tracking-[0.04em]"
                      style={{ color: DECK.muted }}
                    >
                      {columns[ci + 1]?.label}
                    </span>
                    <span
                      className="text-sm tabular-nums"
                      style={{ color: DECK.ink }}
                    >
                      <RenderCell cell={cell} />
                    </span>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>

        {/* ── Desktop: the real table, centred in the stage. ── */}
        <div
          className="reveal hidden w-full overflow-hidden rounded-xl sm:block"
          data-show={active ? "true" : "false"}
          style={{
            background: DECK.surface,
            border: `1px solid ${DECK.cardBorder}`,
            transitionDelay: active ? "100ms" : "0ms",
          }}
        >
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th
                    key={i}
                    className={cn(
                      "text-[11px] font-medium uppercase tracking-wide sm:text-sm",
                      dense
                        ? "px-3 py-2.5 sm:px-5 sm:py-3"
                        : "px-3 py-3 sm:px-6 sm:py-4",
                      c.align === "right" ? "text-right" : "text-left",
                    )}
                    style={{
                      color: DECK.muted,
                      borderBottom: `1px solid ${DECK.border}`,
                    }}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr
                  key={ri}
                  style={{
                    borderBottom:
                      ri < rows.length - 1
                        ? `1px solid ${DECK.border}`
                        : undefined,
                    background:
                      ri === highlightRow ? "rgba(40,37,36,0.04)" : undefined,
                  }}
                >
                  {row.map((cell, ci) => {
                    const right = columns[ci]?.align === "right";
                    return (
                      <td
                        key={ci}
                        className={cn(
                          "align-top tracking-[-0.01em] tabular-nums",
                          dense
                            ? "px-3 py-1.5 text-sm sm:px-5 sm:py-2.5 sm:text-base"
                            : "px-3 py-3 text-sm sm:px-6 sm:py-4 sm:text-lg",
                          right ? "text-right" : "text-left font-medium",
                        )}
                      >
                        <RenderCell cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
