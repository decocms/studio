/**
 * A figure opened up (`BlogEvidenceDetail`): the series behind it, the numbers
 * beside it, the bars that compare it, the products and dates it is about.
 * Each part draws only when the agent recorded it. The card is written by an
 * agent, which can also write the file directly, so a link or an image is
 * used only when its address is https.
 */

import { ArrowRight } from "@untitledui/icons";
import type { BlogEvidenceDetail } from "@decocms/shared/blog-card";
import { cn } from "@decocms/ui/lib/utils.ts";

const isHttps = (url: string | undefined): url is string =>
  !!url && /^https:\/\/\S+$/i.test(url);

export function EvidenceDetail({ detail }: { detail: BlogEvidenceDetail }) {
  return (
    <div className="flex flex-col gap-3.5">
      {detail.trend && detail.trend.points.length > 1 && (
        <Trend trend={detail.trend} />
      )}
      {detail.stats && detail.stats.length > 0 && (
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {detail.stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-0.5">
              <dt className="text-[11.5px] text-muted-foreground">
                {stat.label}
              </dt>
              <dd className="text-[15px] font-semibold text-foreground tabular-nums">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {detail.compare && detail.compare.length > 1 && (
        <Compare bars={detail.compare} />
      )}
      {detail.products && detail.products.length > 0 && (
        <ul className="flex flex-col gap-2">
          {detail.products.map((product) => (
            <li
              key={product.name}
              className="flex items-center gap-3 text-[13px]"
            >
              {isHttps(product.image) ? (
                <img
                  src={product.image}
                  alt=""
                  className="size-9 shrink-0 rounded-md bg-muted object-cover"
                />
              ) : (
                <span className="size-9 shrink-0 rounded-md bg-muted" />
              )}
              <span className="min-w-0 flex-1 truncate text-foreground">
                {product.name}
                {product.note && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {product.note}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {detail.timeline && detail.timeline.length > 1 && (
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
          {detail.timeline.map((date, index) => (
            <li
              key={`${date.date}:${index}`}
              className="flex items-center gap-2"
            >
              {index > 0 && (
                <ArrowRight size={12} className="text-muted-foreground" />
              )}
              {date.now && (
                <span className="size-1.5 shrink-0 rounded-full bg-[var(--chart-1)]" />
              )}
              <span className="font-semibold text-foreground tabular-nums">
                {date.date}
              </span>
              {date.label && (
                <span className="text-muted-foreground">{date.label}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** "Open in GA4 →", when the agent left the address of the report. */
export function EvidenceLink({
  link,
  fallbackLabel,
}: {
  link: BlogEvidenceDetail["link"];
  fallbackLabel: string;
}) {
  if (!link || !isHttps(link.url)) return null;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 self-start text-[12.5px] text-muted-foreground hover:text-foreground"
    >
      {link.label || fallbackLabel}
      <ArrowRight size={12} />
    </a>
  );
}

const TREND_WIDTH = 600;
const TREND_HEIGHT = 64;
const TREND_PAD = 4;

/** One series as a line, each point's value on hover. */
function Trend({ trend }: { trend: NonNullable<BlogEvidenceDetail["trend"]> }) {
  const { points } = trend;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const step = (TREND_WIDTH - 2 * TREND_PAD) / (points.length - 1);
  const x = (index: number) => TREND_PAD + index * step;
  const y = (value: number) =>
    TREND_HEIGHT -
    TREND_PAD -
    ((value - min) / span) * (TREND_HEIGHT - 2 * TREND_PAD);
  const path = points
    .map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`)
    .join(" ");
  const first = points[0]?.toLocaleString() ?? "";
  const last = points[points.length - 1]?.toLocaleString() ?? "";

  return (
    <figure className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${trend.label ?? ""} ${first} → ${last}`.trim()}
        className="h-16 w-full overflow-visible"
      >
        <path
          d={path}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          className="stroke-[var(--chart-1)]"
        />
        {points.map((value, index) => (
          <rect
            key={index}
            x={x(index) - step / 2}
            y={0}
            width={step}
            height={TREND_HEIGHT}
            fill="transparent"
          >
            <title>{value.toLocaleString()}</title>
          </rect>
        ))}
      </svg>
      {(trend.from || trend.label || trend.to) && (
        <figcaption className="flex justify-between gap-3 text-[11px] text-muted-foreground tabular-nums">
          <span>{trend.from}</span>
          <span className="truncate">{trend.label}</span>
          <span>{trend.to}</span>
        </figcaption>
      )}
    </figure>
  );
}

/** Bars side by side, the subject first and darker, each with how it reads. */
function Compare({
  bars,
}: {
  bars: NonNullable<BlogEvidenceDetail["compare"]>;
}) {
  const max = Math.max(...bars.map((bar) => bar.value)) || 1;
  return (
    <ul className="flex flex-col gap-2">
      {bars.map((bar, index) => (
        <li
          key={`${bar.label}:${index}`}
          title={`${bar.label}: ${bar.display}`}
          className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[12.5px]"
        >
          <span className="truncate text-muted-foreground">{bar.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                "block h-full rounded-full",
                index === 0 ? "bg-foreground" : "bg-muted-foreground/50",
              )}
              style={{ width: `${Math.max(2, (bar.value / max) * 100)}%` }}
            />
          </span>
          <span className="font-medium text-foreground tabular-nums">
            {bar.display}
          </span>
        </li>
      ))}
    </ul>
  );
}
