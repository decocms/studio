/**
 * Scenario — "It's agents all the way down."
 *
 * One continuous walkthrough of the simplified Studio navigation model:
 *
 *   path = context. A topbar breadcrumb (deco > org > agent) is the only
 *   navigation AND the chat's scope selector. There's always a chat; the
 *   breadcrumb says who it is. The logo takes you to yourself.
 *
 * Beats:
 *   1. Home — your deco. The REAL home look (hero, capybara, composer, corner
 *      art) with your orgs as tiles below — each org an agent that reports.
 *      "Good morning — what needs me?" fans out to every org's pilot.
 *   2. Hop into an org via its tile → breadcrumb grows → same product, one
 *      level down. Give the org's pilot a task; watch the storefront change.
 *   3. Zoom into one agent inside the org → breadcrumb grows again.
 *   4. Share (right next to the breadcrumb) — every level mints an MCP URL
 *      for exactly that scope.
 *   5. Logo → home. The tiles already reflect the work. Turtles all the way.
 *
 * All data is mocked; the chat pipeline is the REAL renderer, and the chrome
 * copies the real shell's classes/assets (bg-sidebar body, card-shadow float
 * cards, the home hero + capybara, the composer's Tools/scope/model rows).
 */
import {
  ArrowUp,
  ChevronDown,
  Cloud01,
  Microphone01,
  Sliders01,
  Stars01,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Chat } from "@/web/components/chat";
import { DemoChatStreamProvider } from "../demo-chat-stream";
import { PreviewFrame } from "../chrome";
import { genericTool } from "../message-builders";
import {
  useDemoInput,
  useNotified,
  useTrackBusy,
  useTrackHasMessages,
} from "../use-demo-stores";
import type { Director, Track } from "../director";
import type { DemoStores } from "../director-stores";
import type { Scenario } from "../types";

// ============================================================================
// Cast
// ============================================================================

/** 12-point series behind each org's sparkline (unitless, scaled to fit). */
const SPARK = {
  vela: [42, 45, 44, 48, 52, 50, 55, 58, 56, 62, 66, 71],
  aurora: [3.4, 3.2, 3.3, 3.0, 2.8, 2.9, 2.6, 2.5, 2.4, 2.3, 2.2, 2.1],
  atlas: [2, 4, 3, 5, 4, 6, 5, 4, 6, 7, 5, 6],
} as const;

/**
 * Each org card is a mini-dashboard: three metric squares — a stat tile with a
 * delta, a 12-point sparkline, and a watched number (the third slot can be
 * overridden live via the `metric:<org>` input so the demo can show work
 * changing a number). Sparkline strokes are the 700 steps of each org's hue —
 * validated ≥3:1 on the light surface; one hue per plot, labeled by the card.
 */
const ORGS = [
  {
    id: "vela",
    name: "Vela Store",
    glyph: "V",
    tagline: "Fashion storefront",
    tile: "bg-lime-200 text-lime-950",
    spark: "text-lime-700",
    metrics: {
      stat: { label: "Sessions", value: "12.4k", delta: "+8%" },
      trend: { label: "Revenue · 7d", points: SPARK.vela, value: "$86k" },
      watch: { label: "LCP", fallback: "1.9s" },
    },
  },
  {
    id: "aurora",
    name: "Aurora Coffee",
    glyph: "A",
    tagline: "DTC subscriptions",
    tile: "bg-amber-200 text-amber-950",
    spark: "text-amber-700",
    metrics: {
      stat: { label: "MRR", value: "$24k", delta: "+3%" },
      trend: { label: "Churn · 7d", points: SPARK.aurora, value: "2.1%" },
      watch: { label: "Subscribers", fallback: "1,840" },
    },
  },
  {
    id: "atlas",
    name: "Atlas Labs",
    glyph: "L",
    tagline: "B2B SaaS",
    tile: "bg-sky-200 text-sky-950",
    spark: "text-sky-700",
    metrics: {
      stat: { label: "Uptime", value: "99.98%", delta: "" },
      trend: { label: "Deploys · 7d", points: SPARK.atlas, value: "32" },
      watch: { label: "Open PRs", fallback: "3" },
    },
  },
] as const;

type Org = (typeof ORGS)[number];

const VELA_AGENTS = [
  {
    id: "vela",
    name: "Vela Pilot",
    sub: "the org's teammate",
    glyph: "V",
    tile: "bg-lime-200 text-lime-950",
  },
  {
    id: "vela-bot",
    name: "Storefront Bot",
    sub: "vela.shop",
    glyph: "S",
    tile: "bg-violet-200 text-violet-950",
  },
  {
    id: "vela-support",
    name: "Support Triage",
    sub: "inbox",
    glyph: "T",
    tile: "bg-pink-200 text-pink-950",
  },
] as const;

const BASE = "https://studio.decocms.com/api";

/** The share URL for the current breadcrumb scope — one MCP URL per level. */
function scopeUrl(level: string, agent: string): string {
  if (level === "agent") return `${BASE}/vela/mcp/${agent || "vela-bot"}`;
  if (level === "org") return `${BASE}/vela/mcp`;
  return `${BASE}/you/mcp`;
}

/** Who the always-available chat is, per breadcrumb level. */
function scopeChipLabel(level: string, agent: string): string {
  if (level === "agent")
    return VELA_AGENTS.find((a) => a.id === agent)?.name ?? "Storefront Bot";
  if (level === "org") return "Vela Pilot";
  return "Decopilot";
}

// ============================================================================
// Preview HTML (vela.shop before/after)
// ============================================================================

const STYLE = `*{box-sizing:border-box;margin:0;font-family:Inter,system-ui,sans-serif}
body{background:#fff;color:#101828}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid #f0f1f3}
.logo{font-weight:800;letter-spacing:-.02em}
nav a{margin-left:16px;color:#667085;text-decoration:none;font-size:12px}
.banner{background:#1d2939;color:#fff;text-align:center;padding:9px;font-size:12px;font-weight:600}
.hero{padding:44px 22px 28px;text-align:center}
.hero h1{font-size:28px;letter-spacing:-.02em;margin-bottom:10px}
.hero p{color:#667085;font-size:14px}
.cta{display:inline-block;margin-top:16px;background:#101828;color:#fff;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600}
.grid{display:grid;gap:12px;padding:18px 22px;grid-template-columns:repeat(3,1fr)}
.card{border:1px solid #f0f1f3;border-radius:10px;height:96px;background:linear-gradient(135deg,#f9fafb,#f0f1f3)}`;

function velaPreview({ winter }: { winter: boolean }): string {
  const cards = Array.from({ length: 6 }, () => `<div class="card"></div>`);
  return `<!doctype html><html><head><meta charset="utf8"><style>${STYLE}</style></head><body>
    ${winter ? `<div class="banner">❄️ Winter Drop — new collection live</div>` : ""}
    <header><span class="logo">VELA</span><nav><a>New</a><a>Women</a><a>Men</a><a>Cart</a></nav></header>
    <div class="hero">
      <h1>${winter ? "The Winter Drop is here." : "Made to move with you."}</h1>
      <p>${winter ? "Heavyweight knits, technical outerwear — limited run." : "Everyday essentials in natural fabrics."}</p>
      <span class="cta">${winter ? "Shop the drop" : "Shop now"}</span>
    </div>
    <div class="grid">${cards.join("")}</div>
  </body></html>`;
}

// ============================================================================
// Shell chrome — real toolbar look: breadcrumb + Share right beside it
// ============================================================================

function Crumb({
  target,
  active,
  children,
}: {
  target: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      data-demo-target={target}
      className={cn(
        "flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors",
        active
          ? "font-medium text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      {children}
    </span>
  );
}

function SharePopover({ stores }: { stores: DemoStores }) {
  const open = useDemoInput(stores, "share") === "open";
  const level = useDemoInput(stores, "level") || "home";
  const agent = useDemoInput(stores, "agent");
  if (!open) return null;

  const url = scopeUrl(level, agent);
  const scopeLabel =
    level === "agent"
      ? "this agent"
      : level === "org"
        ? "everything in Vela Store"
        : "your entire deco — every org you belong to";

  return (
    <div className="absolute left-0 top-9 z-40 w-80 rounded-xl bg-background p-4 card-shadow animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="text-sm font-medium text-foreground">
        Connect a client to this scope
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        Any MCP client that connects here gets {scopeLabel}, with your role.
      </div>
      <div className="mt-3 break-all rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground">
        {url}
      </div>
      <div className="mt-3 flex gap-2">
        {["Claude Code", "Cursor", "WhatsApp"].map((c) => (
          <span
            key={c}
            className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground"
          >
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function DemoToolbar({ stores }: { stores: DemoStores }) {
  const level = useDemoInput(stores, "level") || "home";
  const agentId = useDemoInput(stores, "agent");
  const agent = VELA_AGENTS.find((a) => a.id === agentId);

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 bg-sidebar px-3">
      <Crumb target="crumb:home" active={level === "home"}>
        <img
          src="/logos/deco logo.svg"
          alt="deco"
          className="size-6 select-none"
        />
        <span>deco</span>
      </Crumb>

      {level !== "home" && (
        <>
          <span className="text-muted-foreground/40">/</span>
          <Crumb target="crumb:org" active={level === "org"}>
            <span className="flex size-5 items-center justify-center rounded-md bg-lime-200 text-[10px] font-semibold text-lime-950">
              V
            </span>
            Vela Store
          </Crumb>
        </>
      )}

      {level === "agent" && agent && (
        <>
          <span className="text-muted-foreground/40">/</span>
          <Crumb target="crumb:agent" active>
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-md text-[10px] font-semibold",
                agent.tile,
              )}
            >
              {agent.glyph}
            </span>
            {agent.name}
          </Crumb>
        </>
      )}

      {/* Share sits right beside the breadcrumb — it shares THIS scope. */}
      <span className="relative ml-2">
        <button
          type="button"
          data-demo-target="share-button"
          className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="size-1.5 rounded-full bg-primary/70" />
          Share
        </button>
        <SharePopover stores={stores} />
      </span>
    </header>
  );
}

// ============================================================================
// Sidebar — real shell look (cream, uppercase section labels, tile avatars)
// ============================================================================

function SidebarSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}

function SidebarRow({
  target,
  active,
  busy,
  tile,
  glyph,
  name,
  sub,
}: {
  target?: string;
  active: boolean;
  busy?: boolean;
  tile: string;
  glyph: React.ReactNode;
  name: string;
  sub?: string;
}) {
  return (
    <span
      data-demo-target={target}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-300",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
      )}
    >
      <span className="relative shrink-0">
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md text-[11px] font-semibold",
            tile,
          )}
        >
          {glyph}
        </span>
        {busy && !active && (
          <span className="absolute -right-1 -top-1 size-2 animate-pulse rounded-full bg-primary/70 ring-2 ring-sidebar" />
        )}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px] font-medium">{name}</span>
        {sub && (
          <span className="truncate text-[11px] text-muted-foreground">
            {sub}
          </span>
        )}
      </span>
    </span>
  );
}

/** Example threads — the sidebar of a product in use, not an empty shell.
 *  Team threads carry the teammate's initial so you can see who's on what. */
const HOME_MY_THREADS = [
  { title: "Winter Drop launch plan", meta: "Vela Store · 2h" },
  { title: "Compare churn across my orgs", meta: "Yesterday" },
  { title: "Q3 investor update draft", meta: "Mon" },
];
const VELA_TEAM_THREADS = [
  { title: "Winter Drop QA checklist", meta: "26m", by: "R" },
  { title: "Restock alerts for knits", meta: "1h", by: "C" },
  { title: "Checkout A/B results", meta: "3h", by: "D" },
];
const VELA_MY_THREADS = [{ title: "Hero copy variants", meta: "2d" }];

function ThreadRow({
  title,
  meta,
  by,
  active,
}: {
  title: string;
  meta: string;
  by?: string;
  active?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
      )}
    >
      {by && (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
          {by}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>
    </span>
  );
}

function DemoSidebar({
  stores,
  level,
  activeAgent,
}: {
  stores: DemoStores;
  level: string;
  activeAgent: string;
}) {
  const velaThreadLive = useDemoInput(stores, "thread:vela") === "1";
  return (
    <nav className="flex w-64 shrink-0 flex-col gap-0.5 overflow-y-auto bg-sidebar p-2 pt-1">
      {level === "home" ? (
        <>
          <SidebarRow
            active
            tile="bg-sidebar-accent text-sidebar-foreground"
            glyph="⌂"
            name="Home"
          />
          <SidebarSectionLabel>My threads</SidebarSectionLabel>
          {HOME_MY_THREADS.map((t) => (
            <ThreadRow key={t.title} {...t} />
          ))}
          <SidebarSectionLabel>Agents {ORGS.length + 1}</SidebarSectionLabel>
          <SidebarRow
            active={false}
            tile="bg-lime-200 text-lime-950"
            glyph={
              <img
                src="/logos/deco logo.svg"
                alt=""
                className="size-4 select-none"
              />
            }
            name="Decopilot"
          />
          {/* Your orgs ARE agents in your personal org — they list here too. */}
          {ORGS.map((o) => (
            <SidebarOrgRow key={o.id} stores={stores} org={o} />
          ))}
        </>
      ) : (
        <>
          {/* Same thread UI inside the org — see what teammates are on. */}
          <span data-demo-target="team-threads" className="contents">
            <SidebarSectionLabel>Team threads</SidebarSectionLabel>
            {VELA_TEAM_THREADS.map((t) => (
              <ThreadRow key={t.title} {...t} />
            ))}
          </span>
          <SidebarSectionLabel>My threads</SidebarSectionLabel>
          {velaThreadLive && (
            <ThreadRow title="Ship the Winter Drop hero" meta="now" active />
          )}
          {VELA_MY_THREADS.map((t) => (
            <ThreadRow key={t.title} {...t} />
          ))}
          <SidebarSectionLabel>Agents {VELA_AGENTS.length}</SidebarSectionLabel>
          {VELA_AGENTS.map((a) => (
            <SidebarAgentRow
              key={a.id}
              stores={stores}
              agent={a}
              active={a.id === activeAgent}
            />
          ))}
        </>
      )}
    </nav>
  );
}

function SidebarOrgRow({ stores, org }: { stores: DemoStores; org: Org }) {
  const busy = useTrackBusy(stores, org.id);
  const needs = useNotified(stores, org.id);
  return (
    <SidebarRow
      active={false}
      busy={busy || needs}
      tile={org.tile}
      glyph={org.glyph}
      name={org.name}
      sub={org.tagline}
    />
  );
}

function SidebarAgentRow({
  stores,
  agent,
  active,
}: {
  stores: DemoStores;
  agent: (typeof VELA_AGENTS)[number];
  active: boolean;
}) {
  const busy = useTrackBusy(stores, agent.id);
  return (
    <SidebarRow
      target={`agent:${agent.id}`}
      active={active}
      busy={busy}
      tile={agent.tile}
      glyph={agent.glyph}
      name={agent.name}
      sub={agent.sub}
    />
  );
}

// ============================================================================
// Composer — clone of the real Chat.Input chrome (Tools · scope · model · send)
// ============================================================================

function ComposerChip({
  icon,
  label,
  chevron,
}: {
  icon?: React.ReactNode;
  label: string;
  chevron?: boolean;
}) {
  return (
    <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground">
      {icon}
      {label}
      {chevron && <ChevronDown size={14} className="opacity-60" />}
    </span>
  );
}

function Composer({
  stores,
  compact,
}: {
  stores: DemoStores;
  compact?: boolean;
}) {
  const value = useDemoInput(stores, "composer");
  const level = useDemoInput(stores, "level") || "home";
  const agent = useDemoInput(stores, "agent");

  return (
    <div
      className={cn(
        "relative flex w-full flex-col rounded-2xl bg-card card-shadow",
        compact ? "min-h-[96px]" : "min-h-[110px] md:min-h-[130px]",
      )}
    >
      <div className="flex-1 px-4 pt-3.5 text-[15px]">
        {value ? (
          <span className="text-foreground">
            {value}
            <span className="ml-px inline-block h-4 w-px animate-pulse bg-foreground align-middle" />
          </span>
        ) : (
          <span className="text-muted-foreground">
            Ask anything, / for prompts, @ for agents &amp; resources...
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 p-2">
        <ComposerChip icon={<Sliders01 size={16} />} label="Tools" />
        <div className="flex-1" />
        <ComposerChip
          icon={<Cloud01 size={16} />}
          label={scopeChipLabel(level, agent)}
          chevron
        />
        <ComposerChip icon={<Stars01 size={16} />} label="Smart" chevron />
        <span className="flex size-8 items-center justify-center rounded-lg text-muted-foreground">
          <Microphone01 size={18} />
        </span>
        <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
          <ArrowUp size={16} />
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// Float card — the real shell's content card (rounded, card-shadow, on cream)
// ============================================================================

function FloatCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("h-full min-h-0 p-0.5", className)}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[0.75rem] bg-background card-shadow">
        {children}
      </div>
    </div>
  );
}

/** Faded decorative corners — same assets as the real home. */
function HomeCorners() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <img
        src="/home/bg-top-left.svg"
        alt=""
        className="absolute left-0 top-0 h-auto w-[420px] select-none opacity-80"
      />
      <img
        src="/home/bg-bottom-right.svg"
        alt=""
        className="absolute bottom-0 right-0 h-auto w-[305px] select-none opacity-80"
      />
    </div>
  );
}

// ============================================================================
// Home level — the real home look, with your orgs as tiles
// ============================================================================

/** 2px single-hue sparkline, no grid/axes — trend shape only, value beside. */
function Sparkline({
  points,
  className,
}: {
  points: readonly number[];
  className?: string;
}) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const W = 64;
  const H = 20;
  const path = points
    .map(
      (v, i) =>
        `${((i / (points.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={cn("h-5 w-full", className)}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function MetricSquare({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[78px] flex-col justify-between rounded-lg border border-border/70 bg-muted/30 p-2.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
        {label}
      </span>
      {children}
    </div>
  );
}

function OrgCard({ stores, org }: { stores: DemoStores; org: Org }) {
  const status = useDemoInput(stores, `status:${org.id}`);
  const dot = useDemoInput(stores, `dot:${org.id}`); // "ok" | "busy" | "needs"
  const needs = useNotified(stores, org.id);
  const watchValue =
    useDemoInput(stores, `metric:${org.id}`) || org.metrics.watch.fallback;
  return (
    <div
      data-demo-target={`org-card:${org.id}`}
      className="flex w-full flex-col rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-accent/40"
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "relative flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold",
            org.tile,
          )}
        >
          {org.glyph}
          {needs && (
            <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-primary ring-2 ring-card animate-in zoom-in duration-300" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {org.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {org.tagline}
          </span>
        </span>
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            dot === "needs" && "bg-primary",
            dot === "busy" && "animate-pulse bg-primary/60",
            (dot === "ok" || !dot) && "bg-muted-foreground/30",
          )}
        />
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        <MetricSquare label={org.metrics.stat.label}>
          <span className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold text-foreground">
              {org.metrics.stat.value}
            </span>
            {org.metrics.stat.delta && (
              <span className="text-[11px] font-medium text-emerald-700">
                ▲ {org.metrics.stat.delta.replace("+", "")}
              </span>
            )}
          </span>
        </MetricSquare>
        <MetricSquare label={org.metrics.trend.label}>
          <Sparkline points={org.metrics.trend.points} className={org.spark} />
          <span className="text-xs font-semibold text-foreground">
            {org.metrics.trend.value}
          </span>
        </MetricSquare>
        <MetricSquare label={org.metrics.watch.label}>
          <span
            key={watchValue}
            className="text-lg font-semibold text-foreground animate-in fade-in duration-500"
          >
            {watchValue}
          </span>
        </MetricSquare>
      </div>

      {status && (
        <div
          key={status}
          className="mt-2.5 border-t border-border pt-2 text-xs leading-relaxed text-muted-foreground animate-in fade-in duration-500"
        >
          {status}
        </div>
      )}
    </div>
  );
}

function HomeLevel({ stores }: { stores: DemoStores }) {
  const hasMessages = useTrackHasMessages(stores, "deco");

  return (
    <FloatCard className="flex-1">
      <div className="relative flex min-h-0 flex-1">
        <HomeCorners />
        {/* Center column — hero → thread, composer always present. */}
        <div className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8">
          {hasMessages ? (
            <div className="flex min-h-0 w-full max-w-[720px] flex-1 flex-col">
              <DemoChatStreamProvider store={stores.getChat("deco")}>
                <Chat>
                  <Chat.Messages />
                </Chat>
              </DemoChatStreamProvider>
            </div>
          ) : (
            // Real home is TOP-anchored when content follows — see DesktopHome.
            <div className="shrink-0 pb-10 pt-28 text-center">
              <p className="text-3xl font-medium text-foreground">
                What's on your mind, Gui?
              </p>
            </div>
          )}
          <div className="relative w-full max-w-[672px] shrink-0 pb-4">
            {!hasMessages && (
              <img
                src="/home/capybara.png"
                alt=""
                aria-hidden
                className="pointer-events-none absolute -top-16 right-6 z-20 h-20 w-auto select-none"
              />
            )}
            <Composer stores={stores} />
          </div>
          {!hasMessages && <div className="flex-1" aria-hidden />}
        </div>
        {/* Org rail — every org you belong to, reporting as an agent.
            Half the surface: the orgs are the home's co-protagonist. */}
        <div className="relative flex min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto border-l border-border/60 p-4">
          <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Your orgs
          </div>
          {ORGS.map((o) => (
            <OrgCard key={o.id} stores={stores} org={o} />
          ))}
          <div className="px-1 text-[11px] leading-relaxed text-muted-foreground/60">
            Each org is a connection and an agent in your personal org — it
            reports here, and you can talk to it.
          </div>
        </div>
      </div>
    </FloatCard>
  );
}

// ============================================================================
// Org / agent levels — same shell, one zoom apart
// ============================================================================

function OrgLevel({
  stores,
  activeAgent,
}: {
  stores: DemoStores;
  activeAgent: string;
}) {
  const previewHtml = useDemoInput(stores, "preview:vela");
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2">
      <FloatCard>
        <div className="flex min-h-0 flex-1 flex-col">
          <DemoChatStreamProvider store={stores.getChat(activeAgent)}>
            <Chat>
              <Chat.Messages />
            </Chat>
          </DemoChatStreamProvider>
          <div className="shrink-0 p-2">
            <Composer stores={stores} compact />
          </div>
        </div>
      </FloatCard>
      <FloatCard>
        <PreviewFrame url="vela.shop" html={previewHtml} />
      </FloatCard>
    </div>
  );
}

// ============================================================================
// Stage
// ============================================================================

function TurtlesStage({ stores }: { stores: DemoStores }) {
  const level = useDemoInput(stores, "level") || "home";
  const agentId = useDemoInput(stores, "agent") || "vela";

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <DemoToolbar stores={stores} />
      <div className="flex min-h-0 flex-1">
        <DemoSidebar
          stores={stores}
          level={level}
          activeAgent={level === "agent" ? agentId : "vela"}
        />
        {/* key on level+agent → each zoom crossfades like a route change */}
        <div
          key={`${level}:${agentId}`}
          className="flex min-h-0 flex-1 flex-col pb-1 pr-1 animate-in fade-in duration-500"
        >
          {level === "home" ? (
            <HomeLevel stores={stores} />
          ) : (
            <OrgLevel
              stores={stores}
              activeAgent={level === "agent" ? agentId : "vela"}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Screenplay
// ============================================================================

const MORNING_DIGEST = `### While you were away

| Org | Status | Needs you |
| --- | --- | --- |
| **Vela Store** | Winter Drop assets approved, hero not shipped | **Yes — ship it** |
| **Aurora Coffee** | Subscription churn down 12% after winback flow | No |
| **Atlas Labs** | All green — 3 PRs merged overnight | No |

One thing needs you: **Vela's Winter Drop hero** is approved and waiting.`;

function orgPilotCall(org: Org, summary: string, latencyMs: number) {
  return genericTool({
    name: "ask_org_pilot",
    input: { org: org.id, question: "morning brief" },
    output: { result: summary },
    latencyMs,
  });
}

/** Ghost-type into the composer, then submit as the track's user message. */
async function say(d: Director, t: Track, text: string) {
  await d.type("composer", text, { cps: 30 });
  await d.beat(350);
  d.setInput("composer", "");
  await t.user(text);
}

async function goodMorning(d: Director) {
  const deco = d.track("deco");

  d.caption("This is your deco — every org you belong to, as an agent");
  await d.beat(2600);

  await say(d, deco, "Good morning — what needs me today?");
  await d.beat(400);
  await deco.think(
    "I'll ask each org's pilot for its overnight report, then rank what actually needs Gui.",
    { cps: 85 },
  );

  d.caption("Your deco asks each org's pilot — in parallel");
  d.setInput("dot:vela", "busy");
  d.setInput("dot:aurora", "busy");
  d.setInput("dot:atlas", "busy");
  await deco.parallel(
    [
      orgPilotCall(ORGS[0], "Winter Drop approved · hero pending", 2300),
      orgPilotCall(ORGS[1], "churn −12% · winback flow working", 2900),
      orgPilotCall(ORGS[2], "all green · 3 PRs merged", 2100),
    ],
    350,
  );

  d.setInput("status:vela", "Winter Drop assets approved — hero not shipped.");
  d.setInput("dot:vela", "needs");
  d.notify("vela");
  d.setInput("status:aurora", "Churn down 12% after the winback flow.");
  d.setInput("dot:aurora", "ok");
  d.setInput("status:atlas", "All green — 3 PRs merged overnight.");
  d.setInput("dot:atlas", "ok");

  await deco.stream(MORNING_DIGEST, { instant: true });
  d.caption("One brief. One thing that needs you.");
  await d.beat(7000); // the money frame — hold long enough to read the table

  // The brief ends in an ACTION, not a paragraph: a card that takes you to
  // the org that needs you, straight into a thread with the question open.
  deco.showCard("org_cta", {
    orgName: "Vela Store",
    glyph: "V",
    tile: "bg-lime-200 text-lime-950",
    headline: "Vela Store needs you",
    body: "Winter Drop hero is staged and waiting on your go.",
    button: "Take me there",
    target: "org-cta",
    chips: [
      { label: "Assets approved", state: "done" },
      { label: "QA passed", state: "done" },
      { label: "Hero not shipped", state: "pending" },
    ],
  });
  deco.endTurn();
  await d.beat(2600);
}

async function hopIntoVela(d: Director) {
  d.caption("The card takes you into the org — thread already open");
  d.showCursor();
  await d.beat(600);
  await d.click("org-cta");
  d.setInput("level", "org");
  d.setOrg("vela");
  d.hideCursor();

  // You land in a thread where Vela's pilot has ALREADY asked the question —
  // answer it and work proceeds. No re-explaining context.
  const vela = d.track("vela");
  d.setInput("thread:vela", "1"); // the thread appears under My threads
  await vela.stream(
    "Morning! The Winter Drop hero is ready — assets approved, QA passed. Ship it now?",
    { cps: 60 },
  );
  vela.endTurn();
  d.caption("Same product, one level down — Vela was already waiting for you");
  await d.beat(2600);

  // The org has the same thread UI — and team threads show who's on what.
  d.caption("Team threads — see what your teammates are working on");
  d.showCursor();
  await d.click("team-threads");
  await d.beat(2400);
  d.hideCursor();

  await say(d, vela, "Yes — ship it.");
  await d.beat(400);
  await vela.think(
    "Assets are approved. I'll swap the hero, publish, and verify.",
    { cps: 85 },
  );
  await vela.stream("On it — swapping the hero for the Winter Drop.", {
    cps: 44,
  });
  await vela.tool(
    genericTool({
      name: "edit_section",
      input: { section: "hero", variant: "winter-drop" },
      output: { result: "hero → Winter Drop · banner enabled" },
      latencyMs: 2200,
    }),
  );
  d.setPreview("vela", velaPreview({ winter: true }));
  await d.beat(1800); // let the storefront swap land before the next tool
  await vela.tool(
    genericTool({
      name: "deploy",
      output: { result: "vela.shop · v87 live" },
      latencyMs: 1800,
    }),
  );
  await vela.stream("✅ Live on vela.shop — Winter Drop hero + banner.", {
    cps: 44,
  });
  vela.endTurn();
  await d.beat(3200);
}

async function zoomIntoAgent(d: Director) {
  d.caption("Go deeper — everything inside an org is an agent too");
  d.showCursor();
  await d.beat(500);
  await d.click("agent:vela-bot");
  d.setInput("level", "agent");
  d.setInput("agent", "vela-bot");
  d.hideCursor();
  await d.beat(900);

  const bot = d.track("vela-bot");
  await say(d, bot, "Keep LCP under 1.5s on the new hero.");
  await d.beat(300);
  await bot.stream("Checking the drop's hero image…", { cps: 44 });
  await bot.tool(
    genericTool({
      name: "audit_page",
      input: { url: "vela.shop", metric: "LCP" },
      output: { result: "LCP 1.9s — hero image 840KB, no preload" },
      latencyMs: 2000,
    }),
  );
  await bot.tool(
    genericTool({
      name: "optimize_asset",
      output: { result: "hero.webp 168KB · preload added · LCP 1.2s" },
      latencyMs: 2300,
    }),
  );
  await bot.stream("Done — LCP is at **1.2s**. I'll keep watching it.", {
    cps: 44,
  });
  bot.endTurn();
  await d.beat(1800);
}

async function shareThisScope(d: Director) {
  d.caption("Every level is an MCP endpoint — Share connects any client HERE");
  d.showCursor();
  await d.beat(600);
  await d.click("share-button");
  d.setInput("share", "open");
  await d.beat(1200);
  d.hideCursor();
  await d.beat(3800); // read the URL + client chips
  d.setInput("share", "");
  await d.beat(400);
}

async function backHome(d: Director) {
  d.caption("The logo takes you back to yourself");
  d.showCursor();
  await d.beat(500);
  await d.click("crumb:home");
  d.setInput("level", "home");
  d.setInput("agent", "");
  d.hideCursor();

  d.setInput("status:vela", "Winter Drop live on vela.shop · LCP 1.2s ✓");
  d.setInput("dot:vela", "ok");
  d.setInput("metric:vela", "1.2s"); // the watched LCP square ticks down live
  await d.beat(1200);

  const deco = d.track("deco");
  await deco.stream(
    "Vela's Winter Drop is live and fast. Nothing else needs you — go have your coffee. ☕",
    { cps: 44 },
  );
  deco.endTurn();
  d.caption(
    "It's agents all the way down — same product, only the zoom changes",
  );
  await d.beat(6500);
}

export const turtlesScenario: Scenario = {
  id: "turtles",
  title: "Your deco — it's agents all the way down",
  Stage: TurtlesStage,
  endCard: {
    title: "It's agents all the way down",
    subtitle:
      "Your deco, your orgs, their agents — one product, one URL per scope.",
  },
  run: async (d: Director) => {
    d.setInput("level", "home");
    d.setPreview("vela", velaPreview({ winter: false }));
    await d.beat(600);

    await goodMorning(d);
    await hopIntoVela(d);
    await zoomIntoAgent(d);
    await shareThisScope(d);
    await backHome(d);
  },
};
