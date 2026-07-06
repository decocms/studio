/**
 * Scenario — "Day zero: set up once, everyone else just arrives."
 *
 * The onboarding companion to `turtles.tsx` (the day-30 story). Same world
 * (Vela Store), same primitives — this is how that running operation got set
 * up in the first place. The thesis is DEFERRED SETUP:
 *
 *   Setup is one technical person's job. They connect the code, the site and
 *   the analytics ONCE; deco reads everything, and the org assembles itself —
 *   an operations dashboard full of real findings and a pre-populated backlog,
 *   like a month with an agency delivered overnight. Then the brand person
 *   (Michelle) is invited and lands on agents already set up — she never sees
 *   GitHub.
 *
 * Beats:
 *   1. Sign-up — the filter: "are you the setup person?" Connect GitHub + site
 *      URL + Analytics (ghost-typed, each connects live).
 *   2. First diagnosis fans out — agents read the site, the code, the data in
 *      parallel (the real chat pipeline + tool cards).
 *   3. The org assembles itself — the preview fills with the operations
 *      dashboard, then a kanban pre-populated with proposed work.
 *   4. "Your operation is ready" — a ping on WhatsApp + email (inline card).
 *   5. Invite the brand — Michelle gets agents already set up, no GitHub.
 *
 * All data is mocked; the chrome + HTML app builders are reused from
 * `turtles.tsx` so both stories share one visual vocabulary.
 */
import { cn } from "@deco/ui/lib/utils.ts";
import { Chat } from "@/web/components/chat";
import { DemoChatStreamProvider } from "../demo-chat-stream";
import { PreviewFrame } from "../chrome";
import { genericTool } from "../message-builders";
import { useDemoInput } from "../use-demo-stores";
import {
  Composer,
  FloatCard,
  HomeCorners,
  orgDashboard,
  settingsApp,
  tasksKanban,
  velaPreview,
} from "./turtles";
import type { Director, Track } from "../director";
import type { DemoStores } from "../director-stores";
import type { Scenario } from "../types";

// ============================================================================
// Cast — the same store from turtles, on its first day.
// ============================================================================

const BRAND = {
  name: "Vela Store",
  glyph: "V",
  tile: "bg-lime-200 text-lime-950",
};

/** The three things the setup person connects — the whole day-zero filter. */
const CONNECTORS = [
  {
    id: "github",
    label: "GitHub repository",
    value: "vela/storefront",
    hint: "the code behind your storefront",
  },
  {
    id: "site",
    label: "Storefront URL",
    value: "vela.shop",
    hint: "what your customers see",
  },
  {
    id: "ga",
    label: "Google Analytics",
    value: "GA4 · 284920117",
    hint: "90 days of traffic & revenue",
  },
] as const;

/** The agents the org assembles with — revealed in the sidebar once set up. */
const SHELL_AGENTS = [
  {
    glyph: "V",
    name: "Vela Agent",
    sub: "runs the team",
    tile: "bg-lime-200 text-lime-950",
  },
  {
    glyph: "S",
    name: "Storefront Bot",
    sub: "vela.shop",
    tile: "bg-violet-200 text-violet-950",
  },
  {
    glyph: "O",
    name: "Store Ops",
    sub: "sales · analytics",
    tile: "bg-pink-200 text-pink-950",
  },
  {
    glyph: "G",
    name: "SEO Agent",
    sub: "search & content",
    tile: "bg-sky-200 text-sky-950",
  },
  {
    glyph: "⚙",
    name: "Settings",
    sub: "this org, as apps",
    tile: "bg-muted text-muted-foreground",
  },
] as const;

// ============================================================================
// Setup pane — the sign-up filter (role) + connect checklist
// ============================================================================

function StatusTag({ state }: { state: string }) {
  if (state === "done") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-bold text-emerald-700">
        ✓
      </span>
    );
  }
  if (state === "connecting") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
        Connecting…
      </span>
    );
  }
  return (
    <span className="text-[11px] font-medium text-muted-foreground/70">
      Connect
    </span>
  );
}

function ConnectRow({
  stores,
  id,
  label,
  hint,
}: {
  stores: DemoStores;
  id: string;
  label: string;
  hint: string;
}) {
  const value = useDemoInput(stores, `v:${id}`);
  const state = useDemoInput(stores, `c:${id}`);
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors duration-300",
        state === "done"
          ? "border-border bg-muted/30"
          : "border-border bg-card",
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold",
          id === "github"
            ? "bg-foreground text-background"
            : id === "site"
              ? "bg-lime-200 text-lime-950"
              : "bg-amber-200 text-amber-950",
        )}
      >
        {id === "github" ? "GH" : id === "site" ? "↗" : "GA"}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        <span className="truncate font-mono text-[12px] text-muted-foreground">
          {value || hint}
          {state === "connecting" && (
            <span className="ml-px inline-block h-3 w-px animate-pulse bg-foreground align-middle" />
          )}
        </span>
      </span>
      <StatusTag state={state} />
    </div>
  );
}

function SetupPane({ stores }: { stores: DemoStores }) {
  const role = useDemoInput(stores, "su:role");
  // Call one hook per connector, unconditionally — never inside a loop/callback
  // that can short-circuit (that changes the hook count between renders).
  const github = useDemoInput(stores, "c:github");
  const site = useDemoInput(stores, "c:site");
  const ga = useDemoInput(stores, "c:ga");
  const ready = github === "done" && site === "done" && ga === "done";

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <HomeCorners />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-7 card-shadow animate-in fade-in zoom-in-95 duration-500">
        <img
          src="/logos/deco logo.svg"
          alt=""
          className="mb-4 size-9 select-none"
        />
        {!role ? (
          <>
            <h2 className="text-xl font-semibold text-foreground">
              Welcome to deco
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              deco operates your digital experience. First — who's setting this
              up?
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                data-demo-target="role-setup"
                className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/50"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-[13px] font-bold text-background">
                  GH
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">
                    I'll set it up
                  </span>
                  <span className="text-xs text-muted-foreground">
                    I have the code, the site and the analytics
                  </span>
                </span>
              </button>
              <button
                type="button"
                data-demo-target="role-brand"
                className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-muted-foreground transition-colors hover:bg-accent/50"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-[13px]">
                  ✦
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">
                    I'm here for the brand
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Someone technical will invite me later
                  </span>
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-foreground">
              Connect your world
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Point deco at your code, your site and your analytics. This is the
              only technical step — ever.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              {CONNECTORS.map((c) => (
                <ConnectRow
                  key={c.id}
                  stores={stores}
                  id={c.id}
                  label={c.label}
                  hint={c.hint}
                />
              ))}
            </div>
            <button
              type="button"
              data-demo-target="run-diagnosis"
              disabled={!ready}
              className={cn(
                "mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors",
                ready
                  ? "bg-foreground text-background"
                  : "cursor-not-allowed bg-muted text-muted-foreground",
              )}
            >
              Run my first diagnosis
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Shell — slim breadcrumb + assembled agents sidebar + chat/preview
// ============================================================================

function DayZeroToolbar({ stores }: { stores: DemoStores }) {
  const phase = useDemoInput(stores, "phase") || "setup";
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 bg-sidebar px-3 text-sm">
      <img
        src="/logos/deco logo.svg"
        alt="deco"
        className="size-6 select-none"
      />
      <span>deco</span>
      {phase === "shell" && (
        <>
          <span className="text-muted-foreground/40">/</span>
          <span className="flex items-center gap-2 font-medium text-foreground">
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-md text-[10px] font-semibold",
                BRAND.tile,
              )}
            >
              {BRAND.glyph}
            </span>
            {BRAND.name}
          </span>
        </>
      )}
    </header>
  );
}

function AssembledSidebar({ stores }: { stores: DemoStores }) {
  // Agents flip in one by one as the org assembles (driven by `agents:n`).
  const shown = Number(useDemoInput(stores, "agents:n") || "0");
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto bg-sidebar p-2 pt-1">
      <div className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Agents {shown > 0 ? shown : ""}
      </div>
      {SHELL_AGENTS.slice(0, shown).map((a) => (
        <span
          key={a.name}
          className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left animate-in fade-in slide-in-from-left-2 duration-500"
        >
          <span
            className={cn(
              "flex size-6 items-center justify-center rounded-md text-[11px] font-semibold",
              a.tile,
            )}
          >
            {a.glyph}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[13px] font-medium text-sidebar-foreground">
              {a.name}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {a.sub}
            </span>
          </span>
        </span>
      ))}
      {shown === 0 && (
        <div className="px-2 py-4 text-[12px] leading-relaxed text-muted-foreground/70">
          Assembling your team…
        </div>
      )}
      <button
        type="button"
        data-demo-target="invite-team"
        className="mt-auto flex items-center gap-2.5 rounded-lg border border-dashed border-border px-2 py-2 text-left text-[13px] font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60"
      >
        <span className="flex size-6 items-center justify-center rounded-md bg-muted text-[13px] text-muted-foreground">
          +
        </span>
        Invite your team
      </button>
    </nav>
  );
}

function ShellLevel({ stores }: { stores: DemoStores }) {
  const previewHtml = useDemoInput(stores, "preview:vela");
  const previewUrl = useDemoInput(stores, "preview-url") || "vela · operations";
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2">
      <FloatCard>
        <div className="flex min-h-0 flex-1 flex-col">
          <DemoChatStreamProvider store={stores.getChat("vela")}>
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
        <PreviewFrame url={previewUrl} html={previewHtml} />
      </FloatCard>
    </div>
  );
}

function DayZeroStage({ stores }: { stores: DemoStores }) {
  const phase = useDemoInput(stores, "phase") || "setup";
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <DayZeroToolbar stores={stores} />
      <div className="flex min-h-0 flex-1">
        {phase === "shell" && <AssembledSidebar stores={stores} />}
        <div
          key={phase}
          className="flex min-h-0 flex-1 flex-col pb-1 pr-1 animate-in fade-in duration-500"
        >
          {phase === "shell" ? (
            <ShellLevel stores={stores} />
          ) : (
            <FloatCard className="flex-1">
              <SetupPane stores={stores} />
            </FloatCard>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Screenplay
// ============================================================================

/** Ghost-type into the composer, then submit as the track's user message. */
async function say(d: Director, t: Track, text: string) {
  await d.type("composer", text, { cps: 30 });
  await d.beat(300);
  d.setInput("composer", "");
  await t.user(text);
}

async function signUp(d: Director) {
  await d.caption("Welcome to deco — let's set up your operation");
  await d.beat(2600);

  // The filter: setup is one technical person's job.
  await d.caption(
    "Setup takes one technical person — everyone else just gets invited",
  );
  d.showCursor();
  await d.beat(700);
  await d.click("role-setup");
  d.setInput("su:role", "setup");
  d.hideCursor();
  await d.beat(700);

  // Connect the three sources, ghost-typed, each resolving live.
  await d.caption("Point deco at your code, your site, and your analytics");
  for (const c of CONNECTORS) {
    await d.type(`v:${c.id}`, c.value, { cps: 34 });
    await d.beat(200);
    d.setInput(`c:${c.id}`, "connecting");
    await d.beat(950);
    d.setInput(`c:${c.id}`, "done");
    await d.beat(450);
  }
  await d.beat(700);

  d.showCursor();
  await d.click("run-diagnosis");
  d.hideCursor();
}

async function firstDiagnosis(d: Director) {
  // Into the shell — the org exists now; the agents haven't assembled yet.
  d.setInput("phase", "shell");
  d.setInput("preview-url", "vela.shop");
  d.setPreview("vela", velaPreview({ winter: false }));
  d.setInput("agents:n", "1"); // the pilot is first to appear
  await d.beat(500);

  const vela = d.track("vela").setSender({
    name: "Vela Agent",
    glyph: "V",
    tile: "bg-lime-200 text-lime-950",
  });

  await d.caption(
    "Now deco reads everything at once — your site, your code, your data",
  );
  await vela.stream(
    "Give me two minutes with your store — I'll read the site, the code, and the last 90 days of analytics.",
    { cps: 52 },
  );
  await vela.think(
    "Fan out: crawl the storefront, audit Core Web Vitals, check the tracking, and read the VTEX theme in the repo — all at once.",
    { cps: 90 },
  );

  // The fan-out — the diagnosis made visible.
  await vela.parallel(
    [
      genericTool({
        name: "crawl_site",
        input: { url: "vela.shop", pages: 34 },
        output: { result: "34 pages crawled · 1,240 PLPs missing canonical" },
        latencyMs: 2600,
      }),
      genericTool({
        name: "audit_web_vitals",
        input: { checks: ["LCP", "CLS", "INP"] },
        output: {
          result: "PDP LCP 3.4s (poor) · hero image 840KB, no preload",
        },
        latencyMs: 3000,
      }),
      genericTool({
        name: "check_tracking",
        input: { source: "GA4" },
        output: { result: "purchase event double-firing on ~6% of orders" },
        latencyMs: 2200,
      }),
      genericTool({
        name: "read_repo",
        input: { repo: "vela/storefront" },
        output: {
          result: "VTEX Intelligent Search 400s on `_gl` param → empty PLPs",
        },
        latencyMs: 3400,
      }),
    ],
    400,
  );

  // Findings land → the operations dashboard fills in.
  await d.caption("It turns every finding into your operations dashboard");
  d.setInput("preview-url", "vela · operations");
  d.setPreview("vela", orgDashboard());
  d.setInput("agents:n", "4"); // specialists assemble around the pilot
  await vela.stream(
    "Done. I read 34 pages, your VTEX theme and 90 days of GA4 — and found **23 things** worth fixing. Three are costing you money right now.",
    { cps: 46 },
  );
  vela.endTurn();
  await d.beat(3600);
}

async function orgAssembles(d: Director) {
  const vela = d.track("vela");

  await d.caption(
    "And a full backlog — like a month with an agency, prioritized overnight",
  );
  // The backlog, as an inline plan card — queued, then triaged live.
  vela.showPlan("Proposed backlog · 23 tasks · top 5", [
    {
      title: "Strip GA tracking params before VTEX IS lookup",
      detail: "Conversion · +R$48k/day recovered",
    },
    {
      title: "Preload PDP hero image + fetchpriority",
      detail: "Performance · +1.8% conversion (est.)",
    },
    {
      title: "Add canonical tag to PLP template",
      detail: "SEO · +18k organic sessions/mo",
    },
    {
      title: "De-dupe GA4 purchase event by transaction_id",
      detail: "Tracking · fix 5.8% revenue overstatement",
    },
    {
      title: "Index search synonyms (singular/plural)",
      detail: "SEO · recover 0-result searches",
    },
  ]);
  await d.beat(1400);
  vela.acceptPlan();
  vela.setTask(0, "active");
  await d.beat(700);
  vela.setTask(2, "active");
  await d.beat(700);

  // The board itself — every finding is now a card, assignable to agent or human.
  d.setInput("preview-url", "vela · tasks");
  d.setPreview("vela", tasksKanban());
  await vela.stream(
    "It's all on your board — like you ran six agency workshops overnight, except it's already triaged and assigned. Nothing for you to organize.",
    { cps: 46 },
  );
  vela.endTurn();
  await d.beat(4200);
}

async function operationReady(d: Director) {
  const vela = d.track("vela");
  await d.caption(
    "Two minutes in — your operation is live, and it finds you where you are",
  );
  d.setInput("preview-url", "vela · operations");
  d.setPreview("vela", orgDashboard());
  await d.beat(500);
  // Reuse the org-CTA card as the "ready" moment — a ping, not a dashboard tour.
  vela.showCard("org_cta", {
    orgName: BRAND.name,
    glyph: BRAND.glyph,
    tile: BRAND.tile,
    headline: "Vela Store is ready",
    body: "Set up in 2 minutes. I pinged you on WhatsApp and email — pick up from anywhere.",
    button: "It's live",
    target: "ready-cta",
    chips: [
      { label: "WhatsApp sent", state: "done" },
      { label: "Email sent", state: "done" },
      { label: "Monitors running 24/7", state: "done" },
    ],
  });
  vela.endTurn();
  await d.beat(4600);
}

async function inviteBrand(d: Director) {
  const vela = d.track("vela");
  await d.caption(
    "Invite the brand — Michelle gets agents already set up, and never sees GitHub",
  );
  // The Settings agent's Members app, in the preview.
  d.setInput("preview-url", "vela · settings/members");
  d.setPreview("vela", settingsApp({ rafaAdmin: false }));
  await d.beat(700);
  await say(d, vela, "Invite Michelle as the brand manager.");
  await d.beat(300);
  await vela.tool(
    genericTool({
      name: "invite_member",
      input: { email: "michelle@vela.shop", role: "Brand Manager" },
      output: { result: "Michelle invited · role: Brand Manager" },
      latencyMs: 1500,
    }),
  );
  await vela.stream(
    "Done. Michelle owns the brand — not the plumbing. She lands on her agents and her numbers; she'll never see a repo or a config file.",
    { cps: 46 },
  );
  vela.endTurn();
  await d.beat(1200);

  // Michelle's POV — her operations, agents already set up, no GitHub anywhere.
  d.setInput("preview-url", "vela · operations");
  d.setPreview("vela", orgDashboard());
  await vela.stream(
    "Hi Michelle 👋 I'm your store's agent — everything's already set up. Ask me about today's numbers, or what's ready to ship.",
    { cps: 46 },
  );
  vela.endTurn();
  await d.caption(
    "Set up once — then your whole team just operates through agents",
  );
  await d.beat(5200);
}

export const dayZeroScenario: Scenario = {
  id: "day-zero",
  title: "Day zero — set up once, everyone else just arrives",
  Stage: DayZeroStage,
  endCard: {
    title: "Set up once. Everyone else just arrives.",
    subtitle:
      "One technical setup, then your whole team operates through agents — no repos, no config.",
  },
  run: async (d: Director) => {
    d.setInput("phase", "setup");
    d.setInput("su:role", "");
    await d.beat(500);
    await signUp(d);
    await firstDiagnosis(d);
    await orgAssembles(d);
    await operationReady(d);
    await inviteBrand(d);
  },
};
