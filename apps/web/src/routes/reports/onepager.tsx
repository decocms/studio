/**
 * The public report: one prioritized page instead of a deck. A React port of
 * the engine's own renderer (decocms/reports `api/v2/onepager-page.ts`), fed by
 * the same deterministic object, so the buckets, their order and every claim
 * come from the engine. Nothing here needs a session.
 */

import posthog from "posthog-js";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type {
  OnePager,
  OnePagerBucketId,
  OnePagerItem,
} from "@decocms/shared/reports/public-report";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import { isPostHogInitialized } from "@/lib/posthog-client";
import { reportMarkdownPath, resolveEmailLinkToken } from "./api";
import { onboardingUrl, trackConnectCta } from "./onboarding";
import { captureReport, REPORT_SURFACE } from "./track";

type Tone = "bad" | "warn" | "mid" | "good";

const BUCKET_TONE: Record<OnePagerBucketId, Tone> = {
  critical: "bad",
  important: "warn",
  worth: "mid",
};

const BUCKET_LABEL: Record<OnePagerBucketId, TranslationKey> = {
  critical: "reports.onePager.bucketCritical",
  important: "reports.onePager.bucketImportant",
  worth: "reports.onePager.bucketWorth",
};

/** Registry vocabulary → reader-facing chip. An unknown token renders as-is. */
const DRIVER_LABEL: Record<string, TranslationKey> = {
  Sessions: "reports.onePager.driverSessions",
  CR: "reports.onePager.driverConversion",
  AOV: "reports.onePager.driverOrderValue",
  "Frequency-LTV": "reports.onePager.driverRepeat",
};

const CONTROL_LABEL: Record<string, TranslationKey> = {
  "Deco-controllable": "reports.onePager.controlAgent",
  "Client-dependent": "reports.onePager.controlClient",
  External: "reports.onePager.controlExternal",
};

/** Blocked reason → label; an unknown reason keeps the engine's own label. */
const BLOCKED_LABEL: Record<string, TranslationKey> = {
  "tool-auth": "reports.onePager.blockedToolAuth",
  "data-unavailable": "reports.onePager.blockedDataUnavailable",
  "precondition-unmet": "reports.onePager.blockedPrecondition",
  "tool-unavailable": "reports.onePager.blockedToolUnavailable",
  "not-run": "reports.onePager.blockedNotRun",
  "interview-required": "reports.onePager.blockedInterview",
  "manual-required": "reports.onePager.blockedManual",
};

const PAGE_TYPE_LABEL: Record<string, TranslationKey> = {
  home: "reports.onePager.pageHome",
  pdp: "reports.onePager.pageProduct",
  plp: "reports.onePager.pageCategory",
  blog: "reports.onePager.pageBlog",
};

const scoreTone = (score: number): Tone =>
  score >= 75 ? "good" : score >= 50 ? "warn" : "bad";

/** Only an http(s) URL from the engine reaches an `href` or `src`. */
function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale, {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

const translated = (
  t: TFunction,
  labels: Record<string, TranslationKey>,
  token: string,
): string => {
  const key = labels[token];
  return key ? t(key) : token;
};

/** Open the finding a `#check-<id>` link points at, and bring it into view. */
function openLinkedFinding(root: HTMLElement) {
  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (!hash.startsWith("check-")) return;
  const row = Array.from(root.querySelectorAll("details")).find(
    (el) => el.id === hash,
  );
  if (!row) return;
  row.open = true;
  row.scrollIntoView({ block: "start" });
}

/** One report view: the funnel event, the inbound share, and the email open
 *  (`d` is the unguessable token the engine minted for that email). */
function trackReportView(report: OnePager) {
  captureReport("report_viewed", {
    domain: report.domain,
    score: report.score,
    failed: report.totals.failed,
    surface: REPORT_SURFACE,
  });

  const params = new URLSearchParams(window.location.search);
  const inboundShareId = params.get("share_id");
  if (inboundShareId && isPostHogInitialized()) {
    posthog.setPersonProperties(undefined, {
      inbound_share_id: inboundShareId,
    });
  }

  const emailToken = params.get("d");
  if (!emailToken || params.get("utm_source") !== "email") return;
  const emailRunId = params.get("email_run_id");
  captureReport("report_email_link_opened", {
    domain: report.domain,
    surface: REPORT_SURFACE,
    ...(emailRunId ? { email_run_id: emailRunId } : {}),
  });
  resolveEmailLinkToken(emailToken)
    .then((resolved) => {
      if (!isPostHogInitialized()) return;
      posthog.setPersonProperties(undefined, {
        ...(emailRunId ? { inbound_email_run_id: emailRunId } : {}),
        ...(resolved ? { inbound_email_domain: resolved.domain } : {}),
      });
    })
    .catch(() => {
      if (emailRunId && isPostHogInitialized()) {
        posthog.setPersonProperties(undefined, {
          inbound_email_run_id: emailRunId,
        });
      }
    });
}

export default function OnePagerReport({ report }: { report: OnePager }) {
  const t = useT();
  const [{ language }] = usePreferences();

  const mountRef = (el: HTMLElement | null) => {
    if (!el) return;
    trackReportView(report);
    openLinkedFinding(el);
  };

  const failedBuckets = report.buckets.filter((b) => b.items.length > 0);

  return (
    <div className="dg-page">
      <article ref={mountRef} className="dg" lang={report.lang || undefined}>
        <Header report={report} locale={language} />
        <AgentBar report={report} />
        <Gallery report={report} />
        <Scorecard report={report} />
        {failedBuckets.length ? (
          failedBuckets.map((bucket) => (
            <section key={bucket.id} className="dg-bucket" id={bucket.id}>
              <h2>
                <span
                  className={cn("dg-dot", `dg-${BUCKET_TONE[bucket.id]}`)}
                />
                {t(BUCKET_LABEL[bucket.id])}
                <span className="dg-count">{bucket.items.length}</span>
              </h2>
              <div className="dg-rows">
                {bucket.items.map((item) => (
                  <FindingRow
                    key={item.check_id}
                    domain={report.domain}
                    bucket={bucket.id}
                    item={item}
                  />
                ))}
              </div>
            </section>
          ))
        ) : (
          <section className="dg-bucket">
            <p className="dg-empty">{t("reports.onePager.noFailures")}</p>
          </section>
        )}
        <Coverage report={report} />
        <section className="dg-cta">
          <h2>{t("reports.onePager.ctaTitle")}</h2>
          <p>{t("reports.onePager.ctaText")}</p>
          <a
            href={onboardingUrl(`https://${report.domain}/`)}
            onClick={(e) =>
              trackConnectCta(e, {
                domain: report.domain,
                placement: "report_footer",
              })
            }
          >
            {t("reports.onePager.ctaButton")}
          </a>
        </section>
        <footer className="dg-foot">
          {[
            t("reports.onePager.footerGenerated"),
            report.domain,
            formatDate(report.scanned_at, language),
            t("reports.onePager.footerPublicOnly"),
          ]
            .filter(Boolean)
            .join(" · ")}
        </footer>
      </article>
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const t = useT();
  const size = 104;
  const r = (size - 9) / 2;
  const circumference = 2 * Math.PI * r;
  const filled = (circumference * Math.max(0, Math.min(100, score))) / 100;
  const center = size / 2;
  return (
    <svg
      className={cn("dg-ring", `dg-${scoreTone(score)}`)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={t("reports.onePager.scoreAria", { score })}
    >
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="var(--dg-track)"
        strokeWidth="7"
      />
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={`${filled.toFixed(1)} ${circumference.toFixed(1)}`}
        transform={`rotate(-90 ${center} ${center})`}
      />
      <text
        x="50%"
        y="50%"
        dy="0.06em"
        textAnchor="middle"
        dominantBaseline="middle"
        className="dg-ring-num"
      >
        {score}
      </text>
    </svg>
  );
}

function Header({ report, locale }: { report: OnePager; locale: string }) {
  const t = useT();
  const favicon = safeHttpUrl(report.favicon);
  const date = formatDate(report.scanned_at, locale);
  const stats: Array<[number, TranslationKey]> = [
    [report.totals.failed, "reports.onePager.statFailed"],
    [report.totals.passed, "reports.onePager.statPassed"],
    [report.totals.blocked, "reports.onePager.statBlocked"],
  ];
  return (
    <header className="dg-head">
      <div className="dg-head-top">
        <div className="dg-brand">
          {favicon && <img src={favicon} alt="" width={36} height={36} />}
          <div>
            <h1>{report.brand}</h1>
            <p className="dg-domain">{report.domain}</p>
          </div>
        </div>
        <ShareButton report={report} />
      </div>
      <div className="dg-head-main">
        <div className="dg-head-facts">
          <p className="dg-lede">
            {date
              ? t("reports.onePager.ledeScanned", { date })
              : t("reports.onePager.lede")}
          </p>
          <p className="dg-stats">
            {stats.map(([count, label]) => (
              <span key={label} className="dg-stat">
                <b>{count}</b> {t(label)}
              </span>
            ))}
          </p>
          <p className="dg-meta">
            {report.totals.registry_total > 0
              ? t("reports.onePager.coverageOf", {
                  measured: report.totals.measured,
                  total: report.totals.registry_total,
                })
              : t("reports.onePager.coverage", {
                  measured: report.totals.measured,
                })}
          </p>
        </div>
        {report.score !== null && (
          <div className="dg-head-score">
            <ScoreRing score={report.score} />
            <p className={cn("dg-band", `dg-${scoreTone(report.score)}`)}>
              {report.band}
            </p>
          </div>
        )}
      </div>
    </header>
  );
}

/** A share act mints one share_id, stamped on both the URL (the recipient
 *  reads it back as `inbound_share_id`) and the `report_shared` event. */
function ShareButton({ report }: { report: OnePager }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const share = async () => {
    const shareId = `${report.domain}:report:${crypto.randomUUID().slice(0, 8)}`;
    const params = new URLSearchParams({
      share_id: shareId,
      utm_source: "share",
      utm_medium: "report",
      utm_campaign: "report",
    });
    const url = `${window.location.origin}/report/${encodeURIComponent(
      report.domain,
    )}?${params.toString()}`;
    const shared = (method: string) =>
      captureReport("report_shared", {
        domain: report.domain,
        surface: REPORT_SURFACE,
        method,
        share_id: shareId,
        sharer_person_id: isPostHogInitialized()
          ? posthog.get_distinct_id()
          : undefined,
      });

    if (window.matchMedia("(pointer: coarse)").matches && navigator.share) {
      try {
        await navigator.share({ title: report.brand, url });
        shared("web_share");
      } catch {
        // Dismissed.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      shared("copy_link");
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // No clipboard access; the address bar still has the link.
    }
  };

  return (
    <button type="button" className="dg-share" onClick={share}>
      {copied ? t("reports.onePager.linkCopied") : t("reports.onePager.share")}
    </button>
  );
}

/** Copy the whole report as a prompt for the reader's own agent, or open the
 *  Markdown it is built from. Both read `/report/:domain.md`. Safari keeps the
 *  click's clipboard permission only when the text is handed over as a
 *  promise, hence the `ClipboardItem`. */
function AgentBar({ report }: { report: OnePager }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const markdownUrl = reportMarkdownPath(report.domain, report.lang);

  const copy = async () => {
    const prompt = fetch(markdownUrl).then(async (res) => {
      if (!res.ok) throw new Error(`markdown HTTP ${res.status}`);
      const markdown = await res.text();
      const prefix = t("reports.onePager.promptPrefix", {
        domain: report.domain,
      });
      return `${prefix}\n\n${markdown}`;
    });
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": prompt.then(
              (text) => new Blob([text], { type: "text/plain" }),
            ),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(await prompt);
      }
      setState("copied");
      captureReport("report_prompt_copied", {
        domain: report.domain,
        surface: REPORT_SURFACE,
      });
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  };

  return (
    <section className="dg-agent">
      <p className="dg-agent-text">
        <strong>{t("reports.onePager.agentTitle")}</strong>{" "}
        {t("reports.onePager.agentText")}
      </p>
      <span className="dg-agent-actions">
        <button
          type="button"
          className="dg-copy"
          data-done={state === "copied" ? "" : undefined}
          onClick={copy}
        >
          {state === "copied"
            ? t("reports.onePager.copied")
            : state === "failed"
              ? t("reports.onePager.copyFailed")
              : t("reports.onePager.copyPrompt")}
        </button>
        <a
          className="dg-agent-link"
          href={markdownUrl}
          target="_blank"
          rel="noopener"
          onClick={() =>
            captureReport("report_markdown_opened", {
              domain: report.domain,
              surface: REPORT_SURFACE,
            })
          }
        >
          {t("reports.onePager.openMarkdown")}
        </a>
      </span>
    </section>
  );
}

function Gallery({ report }: { report: OnePager }) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  const shots = report.screenshots.flatMap((shot) => {
    const src = safeHttpUrl(shot.image_url);
    if (!src) return [];
    const page = shot.page_type ? PAGE_TYPE_LABEL[shot.page_type] : undefined;
    const base = page ? t(page) : shot.url;
    const label =
      shot.viewport === "mobile"
        ? t("reports.onePager.shotMobile", { label: base })
        : base;
    return [{ ...shot, src, label, href: safeHttpUrl(shot.url) }];
  });
  if (!shots.length) return null;
  const current = open === null ? undefined : shots[open];

  return (
    <section className="dg-shots" id="capturas">
      <h2>
        {t("reports.onePager.shotsTitle")}
        <span className="dg-count">{shots.length}</span>
      </h2>
      <p className="dg-lede">{t("reports.onePager.shotsLede")}</p>
      <div className="dg-shot-grid">
        {shots.map((shot, i) => (
          <button
            key={`${shot.src}-${i}`}
            type="button"
            className={cn(
              "dg-shot",
              shot.viewport === "mobile" && "dg-shot-mobile",
            )}
            aria-label={t("reports.onePager.enlarge", { label: shot.label })}
            onClick={() => setOpen(i)}
          >
            <img src={shot.src} alt={shot.label} loading="lazy" />
            <span className="dg-shot-cap">{shot.label}</span>
          </button>
        ))}
      </div>
      {current && (
        <div
          className="dg-box"
          role="dialog"
          aria-modal="true"
          aria-label={current.label}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(null);
          }}
        >
          <button
            type="button"
            className="dg-box-bg"
            aria-label={t("reports.onePager.close")}
            onClick={() => setOpen(null)}
          />
          <figure>
            <img src={current.src} alt={current.label} />
            <figcaption>
              {current.label}
              {current.href && (
                <>
                  {" · "}
                  <a href={current.href} rel="noopener nofollow">
                    {new URL(current.href).pathname || "/"}
                  </a>
                </>
              )}
              <button
                type="button"
                className="dg-box-close"
                aria-label={t("reports.onePager.close")}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog's only control; Escape closes it.
                autoFocus
                onClick={() => setOpen(null)}
              >
                ✕
              </button>
            </figcaption>
          </figure>
        </div>
      )}
    </section>
  );
}

function Scorecard({ report }: { report: OnePager }) {
  const t = useT();
  if (!report.categories.length) return null;
  return (
    <section className="dg-areas" id="areas">
      <h2>
        {t("reports.onePager.areasTitle")}
        <span className="dg-count">{report.categories.length}</span>
      </h2>
      <div className="dg-area-list">
        {report.categories.map((area) => (
          <div key={area.key} className="dg-area">
            <span className="dg-area-name">{area.label}</span>
            <span className="dg-bar">
              <span
                className={cn(
                  "dg-bar-fill",
                  `dg-bg-${area.score === null ? "none" : scoreTone(area.score)}`,
                )}
                style={{ width: `${area.score ?? 0}%` }}
              />
            </span>
            {area.score === null ? (
              <span className="dg-muted">—</span>
            ) : (
              <span className="dg-area-score">{area.score}</span>
            )}
            <span className="dg-area-meta">
              {area.score === null
                ? t("reports.onePager.areaInsufficient")
                : area.band}
              {" · "}
              {t("reports.onePager.areaMeasured", {
                count: area.pass + area.fail,
              })}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="dg-part">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function FindingRow({
  domain,
  bucket,
  item,
}: {
  domain: string;
  bucket: OnePagerBucketId;
  item: OnePagerItem;
}) {
  const t = useT();
  const tone = BUCKET_TONE[bucket];
  const chips = [
    item.category,
    item.value_driver && translated(t, DRIVER_LABEL, item.value_driver),
    item.controllability && translated(t, CONTROL_LABEL, item.controllability),
  ].filter((chip): chip is string => Boolean(chip));
  // This store's own sentence beats the check's generic one.
  const why = item.impact ?? item.why;

  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open) return;
    captureReport("report_finding_opened", {
      domain,
      check_id: item.check_id,
      bucket,
      surface: REPORT_SURFACE,
    });
  };

  return (
    <details
      className="dg-row"
      id={`check-${item.check_id}`}
      onToggle={onToggle}
    >
      <summary className="dg-row-head">
        <span className={cn("dg-x", `dg-${tone}`)} aria-hidden="true">
          <svg
            viewBox="0 0 20 20"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <circle cx="10" cy="10" r="7.4" />
            <path d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2" />
          </svg>
        </span>
        <span className="dg-sr">{t("reports.onePager.failedSr")}</span>
        <div className="dg-row-text">
          <h3>{item.title}</h3>
          <div className="dg-chips">
            {chips.map((chip) => (
              <span key={chip} className="dg-chip">
                {chip}
              </span>
            ))}
            {item.value_band === "lever" && (
              <span className="dg-chip dg-chip-lever">
                {t("reports.onePager.chipLever")}
              </span>
            )}
          </div>
        </div>
        <span className="dg-toggle" aria-hidden="true" />
      </summary>
      <div className="dg-row-body">
        {item.description && (
          <Part title={t("reports.onePager.partWhat")}>
            <p className="dg-body-p">{item.description}</p>
          </Part>
        )}
        {why && (
          <Part title={t("reports.onePager.partWhy")}>
            <p className="dg-body-p">{why}</p>
          </Part>
        )}
        {item.tasks.length > 0 && (
          <Part title={t("reports.onePager.partHow")}>
            <ol className="dg-tasks">
              {item.tasks.map((task) => (
                <li key={task}>{task}</li>
              ))}
            </ol>
          </Part>
        )}
        <Part title={t("reports.onePager.partEvidence")}>
          {item.evidence && <p className="dg-ev">{item.evidence}</p>}
          <p className="dg-meta">
            {t("reports.onePager.metaCheck")}{" "}
            <a href={`#check-${item.check_id}`}>
              <code>{item.check_id}</code>
            </a>
          </p>
          {item.sample_scope && (
            <p className="dg-meta">
              {t("reports.onePager.metaSample", { value: item.sample_scope })}
            </p>
          )}
          {item.sources.length > 0 && (
            <p className="dg-meta">
              {t("reports.onePager.metaSource", {
                value: item.sources.join(", "),
              })}
            </p>
          )}
          {item.pages.length > 0 && (
            <p className="dg-meta">
              {t("reports.onePager.metaPages", {
                value: item.pages.join(", "),
              })}
            </p>
          )}
        </Part>
        <div className="dg-actions">
          <FixAction domain={domain} item={item} />
        </div>
      </div>
    </details>
  );
}

/** "Fix automatically" only where our agent can ship the fix; otherwise say
 *  who the fix depends on. */
function FixAction({ domain, item }: { domain: string; item: OnePagerItem }) {
  const t = useT();
  if (item.controllability === "Deco-controllable") {
    return (
      <>
        <a
          className="dg-fix"
          href={onboardingUrl(`https://${domain}/`, item.check_id)}
          onClick={(e) =>
            trackConnectCta(e, {
              domain,
              placement: "finding_fix",
              checkId: item.check_id,
            })
          }
        >
          {t("reports.onePager.fix")}
        </a>
        <span className="dg-fix-note">{t("reports.onePager.fixNote")}</span>
      </>
    );
  }
  if (!item.controllability) return null;
  return (
    <span className="dg-fix-note">
      {item.controllability === "Client-dependent"
        ? t("reports.onePager.fixDependsClient")
        : t("reports.onePager.fixDependsExternal")}
    </span>
  );
}

function Coverage({ report }: { report: OnePager }) {
  const t = useT();
  return (
    <section className="dg-coverage" id="cobertura">
      <details className="dg-fold">
        <summary>
          <span className="dg-dot dg-good" />
          {t("reports.onePager.passingTitle")}
          <span className="dg-count">{report.passing.count}</span>
        </summary>
        <ul className="dg-list">
          {report.passing.items.map((item) => (
            <li key={item.check_id}>
              <code>{item.check_id}</code> {item.title}
            </li>
          ))}
        </ul>
        {report.passing.count > report.passing.items.length && (
          <p className="dg-meta">
            {t("reports.onePager.showingOf", {
              shown: report.passing.items.length,
              total: report.passing.count,
            })}
          </p>
        )}
      </details>
      <details className="dg-fold">
        <summary>
          <span className="dg-dot dg-none" />
          {t("reports.onePager.notMeasuredTitle")}
          <span className="dg-count">{report.not_measured.count}</span>
        </summary>
        <p className="dg-meta">{t("reports.onePager.notMeasuredNote")}</p>
        {report.not_measured.groups.map((group) => (
          <div key={group.reason} className="dg-blocked">
            <strong>
              {group.reason in BLOCKED_LABEL
                ? translated(t, BLOCKED_LABEL, group.reason)
                : group.label}
            </strong>{" "}
            <span className="dg-muted">
              {t("reports.onePager.checksCount", { count: group.count })}
            </span>
            <ul className="dg-list">
              {group.checks.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </section>
  );
}
