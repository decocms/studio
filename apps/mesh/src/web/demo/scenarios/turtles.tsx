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
 *   1. `/` — your deco. Org cards (each org = an agent that reports) + a chat.
 *      "Good morning — what needs me?" fans out to every org's pilot.
 *   2. Hop into an org via its card → breadcrumb grows → same product, one
 *      level down. Give the org's pilot a task; watch the storefront change.
 *   3. Zoom into one agent inside the org → breadcrumb grows again.
 *   4. Share — every breadcrumb level mints an MCP URL for exactly that scope.
 *   5. Logo → home. The cards already reflect the work. Turtles all the way.
 *
 * All data is mocked; the chat pipeline is the REAL renderer driven by the
 * Director (same machinery as the other demo scenarios).
 */
import { cn } from "@deco/ui/lib/utils.ts";
import { Chat } from "@/web/components/chat";
import { DemoChatStreamProvider } from "../demo-chat-stream";
import { PreviewFrame } from "../chrome";
import { genericTool } from "../message-builders";
import { useDemoInput, useNotified, useTrackBusy } from "../use-demo-stores";
import type { Director, Track } from "../director";
import type { DemoStores } from "../director-stores";
import type { Scenario } from "../types";

// ============================================================================
// Cast
// ============================================================================

const ORGS = [
  {
    id: "vela",
    name: "Vela Store",
    domain: "vela.shop",
    glyph: "V",
    tagline: "Fashion storefront",
  },
  {
    id: "aurora",
    name: "Aurora Coffee",
    domain: "auroracoffee.com",
    glyph: "A",
    tagline: "DTC subscriptions",
  },
  {
    id: "atlas",
    name: "Atlas Labs",
    domain: "atlaslabs.io",
    glyph: "L",
    tagline: "B2B SaaS",
  },
] as const;

type Org = (typeof ORGS)[number];

const VELA_AGENTS = [
  { id: "vela", name: "Vela Pilot", sub: "the org's teammate", glyph: "V" },
  { id: "vela-bot", name: "Storefront Bot", sub: "vela.shop", glyph: "S" },
  { id: "vela-support", name: "Support Triage", sub: "inbox", glyph: "T" },
] as const;

const BASE = "https://studio.decocms.com/api";

/** The share URL for the current breadcrumb scope — one MCP URL per level. */
function scopeUrl(level: string, agent: string): string {
  if (level === "agent") return `${BASE}/vela/mcp/${agent || "vela-bot"}`;
  if (level === "org") return `${BASE}/vela/mcp`;
  return `${BASE}/you/mcp`;
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
// Chrome — breadcrumb topbar + share popover
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
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
    <div className="absolute right-4 top-12 z-40 w-80 rounded-xl border border-border bg-card p-4 shadow-xl animate-in fade-in slide-in-from-top-2 duration-300">
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

function Breadcrumb({ stores }: { stores: DemoStores }) {
  const level = useDemoInput(stores, "level") || "home";
  const agentId = useDemoInput(stores, "agent");
  const agent = VELA_AGENTS.find((a) => a.id === agentId);

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-3">
      <Crumb target="crumb:home" active={level === "home"}>
        <span className="flex size-6 items-center justify-center rounded-md bg-foreground text-[11px] font-bold text-background">
          d
        </span>
        <span>deco</span>
      </Crumb>

      {level !== "home" && (
        <>
          <span className="text-muted-foreground/40">/</span>
          <Crumb target="crumb:org" active={level === "org"}>
            Vela Store
          </Crumb>
        </>
      )}

      {level === "agent" && agent && (
        <>
          <span className="text-muted-foreground/40">/</span>
          <Crumb target="crumb:agent" active>
            {agent.name}
          </Crumb>
        </>
      )}

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          data-demo-target="share-button"
          className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="size-1.5 rounded-full bg-primary/70" />
          Share
        </button>
      </div>
      <SharePopover stores={stores} />
    </header>
  );
}

// ============================================================================
// Composer — "there's always a chat"
// ============================================================================

function Composer({ stores }: { stores: DemoStores }) {
  const value = useDemoInput(stores, "composer");
  return (
    <div className="shrink-0 border-t border-border p-3">
      <div className="flex min-h-11 items-center rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm">
        {value ? (
          <span className="text-foreground">
            {value}
            <span className="ml-px inline-block h-4 w-px animate-pulse bg-foreground align-middle" />
          </span>
        ) : (
          <span className="text-muted-foreground">Ask anything…</span>
        )}
      </div>
    </div>
  );
}

function ChatPane({
  stores,
  trackId,
  className,
}: {
  stores: DemoStores;
  trackId: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
    >
      <DemoChatStreamProvider store={stores.getChat(trackId)}>
        <Chat className="bg-card">
          <Chat.Messages />
        </Chat>
      </DemoChatStreamProvider>
      <Composer stores={stores} />
    </div>
  );
}

// ============================================================================
// Home level — your deco
// ============================================================================

function OrgCard({ stores, org }: { stores: DemoStores; org: Org }) {
  const status = useDemoInput(stores, `status:${org.id}`);
  const dot = useDemoInput(stores, `dot:${org.id}`); // "ok" | "busy" | "needs"
  const needs = useNotified(stores, org.id);
  return (
    <div
      data-demo-target={`org-card:${org.id}`}
      className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20"
    >
      <div className="flex items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-foreground">
          {org.glyph}
          {needs && (
            <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-primary ring-2 ring-card animate-in zoom-in duration-300" />
          )}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {org.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {org.tagline}
          </span>
        </span>
        <span
          className={cn(
            "ml-auto size-2 shrink-0 rounded-full",
            dot === "needs" && "bg-primary",
            dot === "busy" && "animate-pulse bg-primary/60",
            (dot === "ok" || !dot) && "bg-muted-foreground/30",
          )}
        />
      </div>
      {status && (
        <div
          key={status}
          className="mt-3 border-t border-border pt-2.5 text-xs leading-relaxed text-muted-foreground animate-in fade-in duration-500"
        >
          {status}
        </div>
      )}
    </div>
  );
}

function HomeLevel({ stores }: { stores: DemoStores }) {
  return (
    <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 grid-cols-[1fr_320px] gap-4 p-4">
      <ChatPane stores={stores} trackId="deco" />
      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto">
        <div className="px-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Your orgs
        </div>
        {ORGS.map((o) => (
          <OrgCard key={o.id} stores={stores} org={o} />
        ))}
        <div className="px-1 pt-1 text-[11px] leading-relaxed text-muted-foreground/60">
          Each org is a connection and an agent in your personal org — it
          reports here, and you can talk to it.
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Org / agent levels — same shell, one zoom apart
// ============================================================================

function AgentRow({
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
    <span
      data-demo-target={`agent:${agent.id}`}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-300",
        active ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      <span className="relative shrink-0">
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-md text-[12px] font-semibold",
            active
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground",
          )}
        >
          {agent.glyph}
        </span>
        {busy && !active && (
          <span className="absolute -right-1 -top-1 size-2 animate-pulse rounded-full bg-primary/70 ring-2 ring-background" />
        )}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span
          className={cn(
            "truncate text-[13px] font-medium",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {agent.name}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {agent.sub}
        </span>
      </span>
    </span>
  );
}

function OrgLevel({
  stores,
  activeAgent,
}: {
  stores: DemoStores;
  activeAgent: string;
}) {
  const previewHtml = useDemoInput(stores, "preview:vela");
  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-border bg-card/40 p-2">
        <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Agents
        </div>
        {VELA_AGENTS.map((a) => (
          <AgentRow
            key={a.id}
            stores={stores}
            agent={a}
            active={a.id === activeAgent}
          />
        ))}
      </nav>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-3">
        <ChatPane stores={stores} trackId={activeAgent} />
        <PreviewFrame url="vela.shop" html={previewHtml} />
      </div>
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
    <div className="flex h-full flex-col">
      <Breadcrumb stores={stores} />
      {/* key on level+agent → each zoom crossfades like a route change */}
      <div
        key={`${level}:${agentId}`}
        className="flex min-h-0 flex-1 flex-col animate-in fade-in duration-500"
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

One thing needs you: **Vela's Winter Drop hero** is approved and waiting. Want me to take you there?`;

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
  deco.endTurn();
  d.caption("One brief. One thing that needs you.");
  await d.beat(9000); // the money frame — hold long enough to read the table
}

async function hopIntoVela(d: Director) {
  d.caption("An org is a context you enter — click through");
  d.showCursor();
  await d.beat(600);
  await d.click("org-card:vela");
  d.setInput("level", "org");
  d.setOrg("vela");
  d.hideCursor();
  await d.beat(900);

  d.caption("Same product, one level down — now you're talking to Vela");
  await d.beat(2200);

  const vela = d.track("vela");
  await say(d, vela, "Ship the Winter Drop hero we approved.");
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
