// Onboarding (redesign mockup, local state only) — modeled on the Atlas /
// DX-360 blueprint: a progressive, self-service diagnostic.
//   url      → point Deco at a store
//   scanning → cold-start diagnostic from PUBLIC data only (no login), building
//              the store's "digital twin"
//   report   → a living diagnostic: a Completeness Index (starts ~35% on public
//              data), opportunities quantified in R$, and a connection → unlock
//              map where each source you grant deepens the analysis and raises
//              completeness. Value before any login; it sharpens as you connect.
//
// The scan animates from the submit handler via `sleep` (no useEffect — banned).
import { useState } from "react";
import { sleep } from "@decocms/std";
import { useNavigate, useParams } from "@tanstack/react-router";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  BarChart10,
  CheckCircle,
  ChevronRight,
  Database01,
  Globe01,
  LifeBuoy01,
  Loading01,
  SearchSm,
  ShoppingBag03,
  Star01,
  Stars02,
  Target04,
  Users01,
  Zap,
} from "@untitledui/icons";
import { HomeBackground } from "@/web/layouts/home-page/background";
import { DecoMark, SectionLabel } from "./primitives";
import { AutonomyDial } from "./goal-detail";
import type { AutonomyMode } from "./mock-data";

type Tone = "good" | "warn" | "issue";

const TONE_DOT: Record<Tone, string> = {
  good: "bg-success",
  warn: "bg-warning",
  issue: "bg-destructive",
};

// Cold-start checks — everything Deco can read from the public store, no login:
// technical (CrUX + crawl), on-page SEO + schema, AI visibility (GEO harness),
// public reputation, and market estimates. The funnel, economics and retention
// layers stay locked until you connect data (see CONNECTIONS).
interface ScanCheck {
  id: string;
  icon: typeof Zap;
  label: string;
  result: string;
  tone: Tone;
}

const CHECKS: ScanCheck[] = [
  {
    id: "technical",
    icon: Zap,
    label: "Technical foundation",
    result:
      "Mobile LCP 3.4s (field), above the 2.5s target. 18 PDPs return 404.",
    tone: "issue",
  },
  {
    id: "seo",
    icon: SearchSm,
    label: "On-page SEO & schema",
    result:
      "412 PDPs missing Product schema, 3 collections without canonicals.",
    tone: "warn",
  },
  {
    id: "geo",
    icon: Stars02,
    label: "AI visibility (GEO)",
    result: "Cited in 8% of category prompts. A competitor shows up in 47%.",
    tone: "issue",
  },
  {
    id: "reputation",
    icon: Star01,
    label: "Reputation",
    result:
      "Reclame Aqui index 7.2, response rate strong, slightly below peers.",
    tone: "warn",
  },
  {
    id: "market",
    icon: BarChart10,
    label: "Market estimate",
    result: "~1.2M visits/mo (SimilarWeb). Organic share trails the top 3.",
    tone: "warn",
  },
];

// Each opportunity is tied to revenue, with effort + confidence (confidence is
// capped until the backing data is connected — the blueprint's evidence model).
interface Opportunity {
  title: string;
  layer: string;
  impact: string;
  effort: "Low" | "Medium" | "High";
  confidence: "Low" | "Medium" | "High";
}

const OPPORTUNITIES: Opportunity[] = [
  {
    title: "Surface PIX & installments earlier in checkout",
    layer: "Experience & conversion",
    impact: "+R$ 220k/yr",
    effort: "Low",
    confidence: "Medium",
  },
  {
    title: "Recover AI visibility in 2 head categories",
    layer: "Demand · GEO",
    impact: "+R$ 170k/yr",
    effort: "Medium",
    confidence: "Medium",
  },
  {
    title: "Add Product schema to 412 PDPs",
    layer: "Technical · SEO",
    impact: "+R$ 90k/yr",
    effort: "Low",
    confidence: "High",
  },
];

// The connection → unlock map (DX-360 order: highest confidence gain first).
// Connecting raises the Completeness Index live.
interface Connection {
  id: string;
  icon: typeof Zap;
  name: string;
  unlocks: string;
  delta: number; // completeness points added
}

const CONNECTIONS: Connection[] = [
  {
    id: "gsc",
    icon: SearchSm,
    name: "Google Search Console",
    unlocks: "Real SEO: queries, lost positions, indexing.",
    delta: 15,
  },
  {
    id: "ga4",
    icon: BarChart10,
    name: "Google Analytics (GA4)",
    unlocks: "The funnel: where sessions drop, by step and device.",
    delta: 20,
  },
  {
    id: "bigquery",
    icon: Database01,
    name: "BigQuery (GA4 export)",
    unlocks: "Exact, unsampled funnel, cohorts and revenue.",
    delta: 10,
  },
  {
    id: "vtex",
    icon: ShoppingBag03,
    name: "VTEX",
    unlocks: "Catalog, AOV, revenue per SKU and orders.",
    delta: 12,
  },
  {
    id: "helpdesk",
    icon: LifeBuoy01,
    name: "Support (Zendesk)",
    unlocks: "Top contact reasons and cost-to-serve.",
    delta: 5,
  },
  {
    id: "crm",
    icon: Users01,
    name: "CRM / ERP",
    unlocks: "Retention, LTV and margin per category.",
    delta: 8,
  },
];

const BASE_COMPLETENESS = 35;

// The closing step: from the scan, Deco proposes the goals it would own — each
// with a target metric and a suggested autonomy. You leave onboarding with goals
// set, not just connections, because a goal is the root object Deco works on.
interface ProposedGoal {
  id: string;
  title: string;
  target: string;
  why: string;
  autonomy: AutonomyMode;
}

const PROPOSED_GOALS: ProposedGoal[] = [
  {
    id: "organic",
    title: "Grow organic traffic",
    target: "+15% organic sessions in 90 days",
    why: "412 PDPs miss schema and a competitor out-ranks you on AI search — recoverable.",
    autonomy: "propose",
  },
  {
    id: "errors",
    title: "Zero error rate",
    target: "0 unhandled errors on the storefront",
    why: "18 PDPs return 404 and mobile LCP is above target — I'll watch and fix.",
    autonomy: "propose",
  },
  {
    id: "conversion",
    title: "Lift mobile conversion",
    target: "+0.5pp add-to-cart on mobile",
    why: "PIX & installments surface late in checkout — worth ~R$220k/yr.",
    autonomy: "inform",
  },
];

type Stage = "url" | "scanning" | "report" | "goals";

export function OnboardingFlow() {
  const navigate = useNavigate();
  const { org } = useParams({ strict: false }) as { org?: string };
  const [stage, setStage] = useState<Stage>("url");
  const [url, setUrl] = useState("farmrio.com");
  const [done, setDone] = useState(0);

  const runScan = async () => {
    setStage("scanning");
    setDone(0);
    for (let i = 1; i <= CHECKS.length; i++) {
      await sleep(600);
      setDone(i);
    }
    await sleep(650);
    setStage("report");
  };

  const enter = () => {
    if (org) navigate({ to: "/$org", params: { org } });
  };

  return (
    <div className="relative h-dvh w-full overflow-y-auto bg-background">
      <HomeBackground />
      <div className="relative mx-auto w-full max-w-[820px] px-6">
        {stage === "url" && (
          <UrlStep url={url} onUrl={setUrl} onSubmit={runScan} />
        )}
        {stage === "scanning" && <ScanningStep url={url} done={done} />}
        {stage === "report" && (
          <ReportStep url={url} onContinue={() => setStage("goals")} />
        )}
        {stage === "goals" && <GoalsStep onEnter={enter} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function UrlStep({
  url,
  onUrl,
  onSubmit,
}: {
  url: string;
  onUrl: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center py-16 text-center">
      <DecoMark className="size-12 text-lg" />
      <h1 className="mt-6 text-2xl font-medium text-foreground">
        Let's diagnose your store.
      </h1>
      <p className="mt-2 max-w-[48ch] text-[15px] leading-relaxed text-muted-foreground">
        Give me your storefront URL and I'll run a full diagnostic from public
        data alone. No login, nothing changes on your site. You'll see real
        opportunities before you connect a thing.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) onSubmit();
        }}
        className="mt-8 flex w-full max-w-[440px] flex-col gap-3"
      >
        <div className="relative">
          <Globe01
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            placeholder="yourstore.com"
            className="h-11 pl-9 text-base"
            aria-label="Storefront URL"
          />
        </div>
        <Button type="submit" size="lg" className="h-11">
          Run the diagnostic
          <ChevronRight size={16} />
        </Button>
      </form>
      <p className="mt-4 text-xs text-muted-foreground">
        Public data only · read-only · takes a few seconds
      </p>
    </div>
  );
}

function ScanningStep({ url, done }: { url: string; done: number }) {
  const pct = Math.round((done / CHECKS.length) * BASE_COMPLETENESS);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center py-16">
      <div className="w-full max-w-[540px]">
        <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
          <Loading01 size={14} className="animate-spin" />
          Building a digital twin of {url}…
        </div>
        <div className="mb-6 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex flex-col gap-1">
          {CHECKS.map((c, i) => {
            const state =
              i < done ? "done" : i === done ? "scanning" : "pending";
            const Icon = c.icon;
            return (
              <div
                key={c.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg px-3 py-3 transition-opacity",
                  state === "pending" && "opacity-40",
                )}
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
                  {state === "scanning" ? (
                    <Loading01 size={14} className="animate-spin" />
                  ) : (
                    <Icon size={14} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {c.label}
                    </span>
                    {state === "done" && (
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          TONE_DOT[c.tone],
                        )}
                      />
                    )}
                  </div>
                  {state === "done" && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {c.result}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReportStep({
  url,
  onContinue,
}: {
  url: string;
  onContinue: () => void;
}) {
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const completeness = Math.min(
    100,
    BASE_COMPLETENESS +
      CONNECTIONS.reduce((sum, c) => sum + (connected[c.id] ? c.delta : 0), 0),
  );
  const connectedCount = Object.values(connected).filter(Boolean).length;

  return (
    <div className="flex flex-col gap-10 py-14">
      {/* Header + the living Completeness Index. */}
      <div className="flex items-start gap-3">
        <DecoMark className="size-9 shrink-0 text-base" />
        <div className="min-w-0 pt-0.5">
          <h1 className="text-xl font-medium text-foreground">
            Here's my first read on {url}.
          </h1>
          <p className="mt-2 max-w-[64ch] text-[15px] leading-relaxed text-muted-foreground">
            From public data alone I can already see roughly{" "}
            <span className="font-medium text-foreground">
              R$ 480k/yr in opportunities
            </span>
            . Connect your data below and I'll sharpen every number, raise my
            confidence, and uncover the parts I can't see yet.
          </p>
        </div>
      </div>

      <CompletenessMeter value={completeness} />

      {/* The money shot: prioritized opportunities, quantified in R$. */}
      <section>
        <SectionLabel>Top opportunities</SectionLabel>
        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1">
          {OPPORTUNITIES.map((o) => (
            <div
              key={o.title}
              className="flex items-start gap-3 rounded-lg px-3 py-3"
            >
              <Target04
                size={16}
                className="mt-0.5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">
                  {o.title}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{o.layer}</span>
                  <span>·</span>
                  <span>{o.effort} effort</span>
                  <span>·</span>
                  <span>{o.confidence} confidence</span>
                </div>
              </div>
              <span className="shrink-0 text-sm font-medium text-success">
                {o.impact}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* What the public scan found. */}
      <section>
        <SectionLabel>From the public scan</SectionLabel>
        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1">
          {CHECKS.map((c) => {
            const Icon = c.icon;
            return (
              <div
                key={c.id}
                className="flex items-start gap-3 rounded-lg px-3 py-3"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn("size-2 rounded-full", TONE_DOT[c.tone])}
                    />
                    <span className="text-sm font-medium text-foreground">
                      {c.label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {c.result}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Connect to go deeper — each source raises completeness live. */}
      <section>
        <SectionLabel>Connect to go deeper</SectionLabel>
        <p className="-mt-1 mb-3 text-sm text-muted-foreground">
          {connectedCount === CONNECTIONS.length
            ? "Everything connected. The diagnostic is as deep as it gets."
            : "Each source raises how much of your store I can diagnose, and how confident I am. I always suggest the highest-impact one first."}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {CONNECTIONS.map((c) => {
            const Icon = c.icon;
            const isOn = !!connected[c.id];
            return (
              <div
                key={c.id}
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-4"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                  <Icon size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {c.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      +{c.delta}%
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {c.unlocks}
                  </p>
                </div>
                {isOn ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
                    <CheckCircle size={14} />
                    Connected
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() =>
                      setConnected((prev) => ({ ...prev, [c.id]: true }))
                    }
                  >
                    Connect
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Continue to goals. */}
      <div className="flex items-center gap-3">
        <Button size="lg" onClick={onContinue}>
          {connectedCount > 0 ? "Set my goals" : "Set my goals, connect later"}
          <ChevronRight size={16} />
        </Button>
        <span className="text-sm text-muted-foreground">
          {completeness}% diagnosed
        </span>
      </div>
    </div>
  );
}

function GoalsStep({ onEnter }: { onEnter: () => void }) {
  const [autonomy, setAutonomy] = useState<Record<string, AutonomyMode>>(() =>
    Object.fromEntries(PROPOSED_GOALS.map((g) => [g.id, g.autonomy])),
  );
  return (
    <div className="flex flex-col gap-8 py-14">
      <div className="flex items-start gap-3">
        <DecoMark className="size-9 shrink-0 text-base" />
        <div className="min-w-0 pt-0.5">
          <h1 className="text-xl font-medium text-foreground">
            Here's what I'd work toward.
          </h1>
          <p className="mt-2 max-w-[64ch] text-[15px] leading-relaxed text-muted-foreground">
            From the diagnostic, these are the goals I'd own. Each one I pursue
            in closed loops — I build the tools, test, and bring you what needs
            a decision. Set how far I can act on each; you can change it
            anytime.
          </p>
        </div>
      </div>

      <section>
        <SectionLabel>Proposed goals</SectionLabel>
        <div className="flex flex-col gap-3">
          {PROPOSED_GOALS.map((g) => (
            <div
              key={g.id}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Target04
                    size={15}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="text-sm font-medium text-foreground">
                    {g.title}
                  </span>
                  <span className="text-xs text-success">{g.target}</span>
                </div>
                <p className="mt-1 max-w-[56ch] text-xs leading-relaxed text-muted-foreground">
                  {g.why}
                </p>
              </div>
              <div className="shrink-0">
                <AutonomyDial
                  value={autonomy[g.id] ?? g.autonomy}
                  onChange={(next) =>
                    setAutonomy((prev) => ({ ...prev, [g.id]: next }))
                  }
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button size="lg" onClick={onEnter}>
          Hire Deco
          <ChevronRight size={16} />
        </Button>
        <span className="text-sm text-muted-foreground">
          {PROPOSED_GOALS.length} goals · adjust anytime in settings
        </span>
      </div>
    </div>
  );
}

function CompletenessMeter({ value }: { value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-2 flex items-end justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">
            Diagnostic completeness
          </div>
          <div className="text-xs text-muted-foreground">
            {value <= BASE_COMPLETENESS
              ? "Public data only. Connect sources to go deeper."
              : "Rising as you connect data."}
          </div>
        </div>
        <div className="text-2xl font-semibold text-foreground">{value}%</div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground transition-all duration-500"
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}
