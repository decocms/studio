import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  ChevronsUpDown,
  Gauge,
  FileSearch,
  AlertTriangle,
  TrendingUp,
  HelpCircle,
  MessageCircle,
  AlertCircle,
  Info,
} from "lucide-react";

type OnboardingState = "idle" | "loading" | "done";

const ISSUES = [
  {
    id: 1,
    severity: "critical" as const,
    text: "38% drop-off between shipping → payment step — industry avg is 22%",
    impact: "~$45K/yr",
  },
  {
    id: 2,
    severity: "critical" as const,
    text: "Purchase event missing transaction_id on 23% of checkouts — GA4 revenue data is unreliable",
    impact: "~$45K/yr",
  },
  {
    id: 3,
    severity: "warning" as const,
    text: "23 product pages missing meta descriptions — CTR drops ~30% without them",
    impact: "-$29K/yr",
  },
  {
    id: 4,
    severity: "warning" as const,
    text: "404 on /collections/winter-sale — receiving 230 hits/hr from Google organic",
    impact: "~$45K/yr",
  },
  {
    id: 5,
    severity: "info" as const,
    text: "Newsletter popup fires immediately on mobile — 62% close rate, 18% exit rate",
    impact: "~$45K/yr",
  },
  {
    id: 6,
    severity: "info" as const,
    text: "Hero images not optimized — adding 2.1s to load time on landing pages",
    impact: "~$45K/yr",
  },
];

const METRICS = [
  { Icon: Gauge, label: "PageSpeed", value: "42" },
  { Icon: FileSearch, label: "SEO", value: "67" },
  { Icon: AlertTriangle, label: "Errors", value: "12" },
  { Icon: TrendingUp, label: "Conversion", value: "2.1%" },
];

function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname;
  } catch {
    return url;
  }
}

function SeverityIcon({
  severity,
}: {
  severity: "critical" | "warning" | "info";
}) {
  if (severity === "critical") {
    return (
      <div className="flex shrink-0 items-center justify-center size-7 rounded-full border border-red-200 bg-red-50">
        <AlertCircle className="size-4 text-red-500" />
      </div>
    );
  }
  if (severity === "warning") {
    return (
      <div className="flex shrink-0 items-center justify-center size-7 rounded-full border border-orange-200 bg-orange-50">
        <AlertCircle className="size-4 text-orange-500" />
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center justify-center size-7 rounded-full border border-blue-200 bg-blue-50">
      <Info className="size-4 text-blue-500" />
    </div>
  );
}

export default function OnboardingRoute() {
  const [url, setUrl] = useState("farmrio.com");
  const [state, setState] = useState<OnboardingState>("idle");
  const [domain, setDomain] = useState("farmrio.com");

  const faviconUrl = domain
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
    : null;

  function handleSubmit() {
    const d = extractDomain(url);
    setDomain(d);
    setState("loading");
    setTimeout(() => setState("done"), 3500);
  }

  const isLoading = state === "loading";
  const isDone = state === "done";
  const hasStarted = isLoading || isDone;

  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-background p-4">
      {/* Top bar - always above */}
      <div className="absolute left-0 right-0 top-8 z-20 flex items-center justify-between px-8">
        <div className="flex items-center gap-2">
          <img src="/logos/deco logo.svg" alt="Deco" className="size-6" />
          <button className="flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted transition-colors">
            <ArrowLeft className="size-4" />
          </button>
        </div>
        <button className="flex h-7 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
          <Globe className="size-4" />
          English
          <ChevronsUpDown className="size-3 text-muted-foreground" />
        </button>
      </div>

      {/* Left: form */}
      <div className="flex h-full flex-1 flex-col items-center justify-center py-8">
        <div className="flex flex-col gap-14">
          <div className="flex flex-col gap-10 text-foreground">
            <div
              className="flex flex-col font-medium leading-[36px]"
              style={{ fontSize: "30px" }}
            >
              <p>Audit your storefront.</p>
              <p className="opacity-50">Fix it with AI.</p>
            </div>
            <div className="flex flex-col gap-2.5 w-[400px]">
              <p className="text-sm font-medium">Website URL</p>
              <div className="flex items-center gap-1 rounded-lg border border-border bg-background px-6 py-4 text-sm">
                <span className="opacity-50 shrink-0">https://</span>
                <input
                  className="flex-1 bg-transparent outline-none placeholder:opacity-50"
                  placeholder="yourstore.com"
                  value={url.replace(/^https?:\/\//, "")}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                />
              </div>
            </div>
          </div>
          <button
            onClick={handleSubmit}
            disabled={hasStarted}
            className="flex w-fit items-center gap-2 rounded-lg px-6 py-3 text-sm font-medium transition-opacity disabled:opacity-60"
            style={{ backgroundColor: "#1b1612", color: "#fbf8f5" }}
          >
            Audit my storefront
            <ArrowRight className="size-4" />
          </button>
        </div>
      </div>

      {/* Right: diagnostic panel */}
      <div
        className="relative flex h-full shrink-0 flex-col overflow-clip rounded-2xl bg-muted px-8 transition-[padding-top] duration-700 ease-out"
        style={{ paddingTop: hasStarted ? "32px" : "300px", width: "764px" }}
      >
        {/* Decorative deco logo */}
        <div
          className="pointer-events-none absolute right-[-1px] top-[-5px] size-[600px] opacity-[0.04]"
          style={{ filter: "grayscale(1)" }}
        >
          <img
            src="/logos/deco logo.svg"
            alt=""
            className="size-full object-contain"
          />
        </div>

        {/* Diagnostic card */}
        <div
          className="relative flex w-[700px] flex-col gap-8 overflow-clip rounded-2xl border border-border bg-background p-7 transition-[max-height] duration-700 ease-out"
          style={{
            maxHeight: isDone ? "1100px" : hasStarted ? "700px" : "440px",
          }}
        >
          {/* Card header */}
          <div className="flex flex-col gap-8 p-3">
            <div className="flex flex-col gap-4">
              {/* Icon + URL */}
              <div className="flex items-center gap-5">
                <div className="flex shrink-0 items-center justify-center size-14 rounded-xl border border-border bg-white shadow-lg overflow-clip">
                  {faviconUrl && hasStarted ? (
                    <img
                      src={faviconUrl}
                      alt={domain}
                      className="size-8 object-contain"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="size-7 opacity-50 flex items-center justify-center">
                      <div className="size-5 rounded-sm border-2 border-muted-foreground" />
                    </div>
                  )}
                </div>
                <p className="text-sm text-muted-foreground opacity-50 overflow-hidden text-ellipsis">
                  {hasStarted ? `https://${domain}` : "https://"}
                </p>
              </div>

              {/* Title */}
              <p className="text-2xl font-medium text-foreground whitespace-pre-wrap min-w-full w-min">
                {isDone
                  ? `${domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1)}'s diagnostic`
                  : "Your diagnostic"}
              </p>
            </div>

            {/* Metrics */}
            <div className="flex items-start justify-between py-3">
              {METRICS.map(({ Icon, label, value }) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4" />
                    <span className="text-[15px] font-medium">{label}</span>
                  </div>
                  <span
                    className={`text-2xl font-medium transition-all duration-500 ${
                      isDone
                        ? "text-muted-foreground opacity-100"
                        : "text-muted-foreground opacity-20"
                    } ${isLoading ? "animate-pulse" : ""}`}
                  >
                    {isDone ? value : "00"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Issues table */}
          <div className="flex flex-col overflow-clip">
            {/* Table header */}
            <div className="flex items-center border-b border-border/50">
              <div className="flex h-[60px] flex-1 items-center px-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                  {isDone ? "FINDINGS" : "AUDIT TO FIND ISSUES"}
                </p>
              </div>
              <div className="h-[60px] w-24 border-b border-border/50" />
            </div>

            {/* Rows */}
            {!hasStarted && (
              <div className="flex items-center py-4 px-3">
                <div className="flex items-center justify-center size-7 rounded-full border border-border bg-muted shrink-0">
                  <HelpCircle className="size-4 text-muted-foreground" />
                </div>
                <p className="ml-3 flex-1 text-xs text-foreground">
                  Audit to find issues...
                </p>
                <p className="text-sm text-muted-foreground">-</p>
              </div>
            )}

            {isLoading && (
              <div className="flex flex-col gap-1 py-2">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-3 py-4 animate-pulse"
                    style={{ animationDelay: `${i * 150}ms` }}
                  >
                    <div className="size-7 rounded-full bg-muted shrink-0" />
                    <div className="h-3 flex-1 rounded bg-muted" />
                    <div className="h-3 w-16 rounded bg-muted" />
                  </div>
                ))}
              </div>
            )}

            {isDone &&
              ISSUES.map((issue, i) => (
                <div
                  key={issue.id}
                  className="flex items-start gap-3 border-b border-border/30 px-3 py-4"
                  style={{
                    animation: `slideUpFade 0.4s ease-out both`,
                    animationDelay: `${i * 100}ms`,
                  }}
                >
                  <SeverityIcon severity={issue.severity} />
                  <p className="flex-1 text-xs text-foreground leading-relaxed">
                    {issue.text}
                  </p>
                  <p className="shrink-0 text-sm font-medium text-red-500">
                    {issue.impact}
                  </p>
                </div>
              ))}

            {/* CTA section - only when done */}
            {isDone && (
              <div
                className="flex flex-col items-center gap-4 px-3 py-8 text-center"
                style={{
                  animation: "slideUpFade 0.5s ease-out both",
                  animationDelay: `${ISSUES.length * 100 + 200}ms`,
                }}
              >
                <div className="flex flex-col gap-1">
                  <p className="text-2xl font-semibold text-red-500">
                    $11.9M/yr at risk
                  </p>
                  <p className="text-xl font-semibold text-foreground">
                    Your storefront needs attention.
                  </p>
                </div>
                <div className="flex items-center gap-6 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="size-4" />
                    12 critical issues
                  </div>
                  <div className="flex items-center gap-2">
                    <HelpCircle className="size-4" />7 total findings
                  </div>
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <button className="flex items-center gap-2 rounded-lg border border-border bg-background px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted">
                    <MessageCircle className="size-4 text-green-500" />
                    Get report on WhatsApp
                  </button>
                  <button className="rounded-lg bg-[#d0ec1a] px-5 py-2.5 text-sm font-semibold text-[#07401a] transition-opacity hover:opacity-90">
                    Fix issues with AI
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Free audit runs once per week
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
