/**
 * Scenario 2 — Studio as a web Conductor: drive several agents in parallel.
 *
 * A sidebar lists the workspace's agents (like the real Studio shell). The
 * viewer kicks one agent off on a long task, switches to another agent via the
 * sidebar to do more work, and the first agent keeps running in the background
 * — when it finishes, a notification dot appears on its sidebar icon. Switching
 * back shows the completed work. Chat (real) on the left, a live preview on the
 * right (isolated iframe).
 */
import { cn } from "@deco/ui/lib/utils.ts";
import { Chat } from "@/web/components/chat";
import { DemoChatStreamProvider } from "../demo-chat-stream";
import { DemoTopBar, PreviewFrame } from "../chrome";
import { DemoLinkDialog, ITermWindow } from "../link-flow";
import { genericTool } from "../message-builders";
import {
  useCurrentOrg,
  useDemoInput,
  useNotified,
  useTrackBusy,
} from "../use-demo-stores";
import type { Director, Track } from "../director";
import type { DemoStores } from "../director-stores";
import type { Scenario } from "../types";

const AGENTS = [
  {
    id: "acme",
    name: "Storefront Bot",
    sub: "Acme Store",
    url: "acme.com",
    glyph: "A",
  },
  {
    id: "north",
    name: "Payments Agent",
    sub: "Northwind",
    url: "app.northwind.com/connections",
    glyph: "N",
  },
  {
    id: "support",
    name: "Support Triage",
    sub: "Helpdesk",
    url: "helpdesk.app/inbox",
    glyph: "H",
  },
] as const;

// ---- preview HTML builders -------------------------------------------------

const STYLE = `*{box-sizing:border-box;margin:0;font-family:Inter,system-ui,sans-serif}
body{background:#fff;color:#0f172a}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid #eef2f7}
.logo{font-weight:800;letter-spacing:-.02em}
nav a{margin-left:16px;color:#64748b;text-decoration:none;font-size:12px}
.banner{background:#0f172a;color:#fff;text-align:center;padding:9px;font-size:12px;font-weight:600;letter-spacing:.01em}
.hero{padding:46px 22px 30px;text-align:center}
.hero h1{font-size:30px;letter-spacing:-.02em;margin-bottom:10px}
.hero p{color:#64748b;font-size:14px}
.cta{display:inline-block;margin-top:16px;background:#16a34a;color:#fff;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600}
.grid{display:grid;gap:12px;padding:18px 22px}
.card{border:1px solid #eef2f7;border-radius:10px;height:96px;background:linear-gradient(135deg,#f8fafc,#eef2f7)}
.conn{display:flex;align-items:center;gap:12px;border:1px solid #eef2f7;border-radius:10px;padding:13px 14px;margin:10px 22px}
.dot{width:26px;height:26px;border-radius:7px;background:#eef2f7;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
.cname{font-size:13px;font-weight:600}
.csub{font-size:11px;color:#94a3b8}
.badge{margin-left:auto;font-size:11px;padding:3px 9px;border-radius:999px;font-weight:600}
.on{background:#dcfce7;color:#166534}
.off{background:#f1f5f9;color:#94a3b8}
h2{font-size:14px;padding:18px 22px 4px;color:#0f172a}`;

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf8"><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function storefront({
  banner,
  cols,
}: {
  banner: boolean;
  cols: number;
}): string {
  const cards = Array.from(
    { length: cols * 2 },
    () => `<div class="card"></div>`,
  ).join("");
  return page(`
    ${banner ? `<div class="banner">☀️ Summer Sale — up to 40% off everything</div>` : ""}
    <header><span class="logo">ACME</span><nav><a>Shop</a><a>New</a><a>Sale</a><a>Cart</a></nav></header>
    <div class="hero">
      <h1>Gear that keeps up.</h1>
      <p>Free shipping over $50 — built for everyday adventures.</p>
      <span class="cta">Shop the sale</span>
    </div>
    <div class="grid" style="grid-template-columns:repeat(${cols},1fr)">${cards}</div>
  `);
}

function connections(active: "stripe" | "adyen"): string {
  const row = (key: string, name: string, sub: string, glyph: string) =>
    `<div class="conn"><div class="dot">${glyph}</div><div><div class="cname">${name}</div><div class="csub">${sub}</div></div><span class="badge ${active === key ? "on" : "off"}">${active === key ? "Active" : "Available"}</span></div>`;
  return page(`
    <header><span class="logo">Northwind · Connections</span></header>
    <h2>Payments</h2>
    ${row("stripe", "Stripe", "Cards · wallets", "S")}
    ${row("adyen", "Adyen", "Cards · wallets · local methods", "A")}
    <h2>Other</h2>
    ${row("shopify", "Shopify", "Catalog sync", "🛍")}
    ${row("slack", "Slack", "Order alerts", "#")}
  `);
}

// ---- stage -----------------------------------------------------------------

type Agent = (typeof AGENTS)[number];

function SidebarAgent({
  stores,
  agent,
  active,
}: {
  stores: DemoStores;
  agent: Agent;
  active: boolean;
}) {
  const busy = useTrackBusy(stores, agent.id);
  const notified = useNotified(stores, agent.id);
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
        {notified && (
          <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-primary ring-2 ring-background animate-in zoom-in duration-300" />
        )}
        {busy && !active && !notified && (
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

function DemoSidebar({
  stores,
  current,
}: {
  stores: DemoStores;
  current: string;
}) {
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-0.5 border-r border-border bg-card/40 p-2">
      <div className="flex items-center gap-2 px-2 py-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-foreground text-[11px] font-bold text-background">
          d
        </span>
        <span className="text-sm font-semibold text-foreground">deco</span>
      </div>
      <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Agents
      </div>
      {AGENTS.map((a) => (
        <SidebarAgent
          key={a.id}
          stores={stores}
          agent={a}
          active={a.id === current}
        />
      ))}
    </nav>
  );
}

function LinkButton({ stores }: { stores: DemoStores }) {
  const linked = useDemoInput(stores, "link") === "connected";
  return (
    <button
      type="button"
      data-demo-target="link-button"
      className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          linked ? "bg-primary" : "bg-muted-foreground/40",
        )}
      />
      {linked ? "Claude Code · MacBook Pro" : "Connect desktop"}
    </button>
  );
}

function AgentsStage({ stores }: { stores: DemoStores }) {
  const current = useCurrentOrg(stores) ?? AGENTS[0].id;
  const meta = AGENTS.find((a) => a.id === current) ?? AGENTS[0];
  const previewHtml = useDemoInput(stores, `preview:${current}`);

  return (
    <div className="flex h-full">
      <DemoSidebar stores={stores} current={current} />
      <div className="flex min-h-0 flex-1 flex-col">
        <DemoTopBar
          org={meta.sub}
          agent={meta.name}
          right={<LinkButton stores={stores} />}
        />
        {/* key on agent → the workspace crossfades when switching agents */}
        <div
          key={current}
          className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-3 animate-in fade-in duration-500"
        >
          <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
            <DemoChatStreamProvider store={stores.getChat(current)}>
              <Chat className="bg-card">
                <Chat.Messages />
              </Chat>
            </DemoChatStreamProvider>
          </div>
          <PreviewFrame url={meta.url} html={previewHtml} />
        </div>
      </div>
      <DemoLinkDialog stores={stores} />
      <ITermWindow stores={stores} />
    </div>
  );
}

// ---- screenplay ------------------------------------------------------------

function codeTool(name: string, result: string, latencyMs: number) {
  return genericTool({ name, output: { result }, latencyMs });
}

const ITERM_AUTH = `$ bunx decocms link

  ↗ Opening browser to authorize…
  ✓ Authorized as dev@acme.com
`;

const ITERM_LINKED = `$ bunx decocms link

  ↗ Opening browser to authorize…
  ✓ Authorized as dev@acme.com
  ✓ Linked to "MacBook Pro"
    • claude-code 2.1    • codex 0.9

  Listening for tasks…  (⌃C to quit)
`;

/** Opening beat: click the topbar link button → modal → iTerm runs
 *  `bunx decocms link` → minimize → modal shows connected. */
async function connectDesktop(d: Director) {
  d.caption("Drive your local Claude Code from the web");
  await d.beat(1300);

  d.showCursor();
  await d.beat(500);
  await d.click("link-button");
  d.setInput("link", "waiting"); // modal opens
  await d.beat(1100);

  // iTerm window appears and the dev runs the link command.
  d.setInput("iterm", "open");
  d.setInput("iterm:text", "");
  await d.beat(500);
  await d.type("iterm:text", "$ bunx decocms link", { cps: 18 });
  await d.beat(750);
  d.setInput("iterm:text", ITERM_AUTH);
  await d.beat(1300);
  d.setInput("iterm:text", ITERM_LINKED);
  await d.beat(1700); // read the linked output

  d.setInput("iterm", "min"); // dev minimizes the terminal
  d.hideCursor();
  await d.beat(950);
  d.setInput("link", "connected"); // modal flips to connected
  await d.beat(2300); // let "Desktop connected" land
  d.setInput("link", ""); // close modal
  d.setInput("iterm", ""); // unmount terminal
  await d.beat(700);
}

/** Move the ghost cursor onto a sidebar agent, click it, and switch the view. */
async function switchAgent(d: Director, id: string) {
  d.showCursor();
  await d.beat(450);
  await d.click(`agent:${id}`);
  d.setOrg(id);
  await d.beat(550);
  d.hideCursor();
}

/** Acme storefront redesign — runs in the background while the viewer is away. */
async function acmeRedesign(d: Director, t: Track) {
  await t.think(
    "I'll add a Summer Sale hero banner, then widen the product grid to 4-up.",
    { cps: 80 },
  );
  await t.stream("Adding the Summer Sale banner and refreshing the hero.", {
    cps: 44,
  });
  await t.tool(codeTool("edit_section", "hero → banner + bold headline", 2400));
  d.setPreview("acme", storefront({ banner: true, cols: 3 }));
  await t.wait(1000); // let the preview change register
  await t.stream("Now widening the product grid to four columns.", { cps: 44 });
  await t.tool(codeTool("update_layout", "product grid → 4 columns", 2200));
  d.setPreview("acme", storefront({ banner: true, cols: 4 }));
  await t.wait(1000);
  await t.tool(codeTool("build", "vite build · 0 errors", 2000));
  await t.tool(codeTool("deploy", "acme.com · v43 live", 1800));
  await t.stream("✅ Live on acme.com — new banner + 4-up grid.", { cps: 44 });
  t.endTurn();
}

/** Northwind MCP swap — done while Acme keeps building. */
async function northSwap(d: Director, t: Track) {
  await t.think(
    "I'll disconnect Stripe, connect Adyen, then re-run the checkout tests.",
    { cps: 80 },
  );
  await t.stream("Swapping the payments MCP from Stripe to Adyen.", {
    cps: 44,
  });
  await t.tool(codeTool("disconnect_mcp", "Stripe · removed", 1700));
  await t.tool(codeTool("connect_mcp", "Adyen · connected", 2000));
  d.setPreview("north", connections("adyen"));
  await t.wait(1000);
  await t.tool(codeTool("run_tests", "checkout smoke · 6 passed", 2200));
  await t.stream("✅ Adyen is now live for checkout.", { cps: 44 });
  t.endTurn();
}

export const agentsScenario: Scenario = {
  id: "agents",
  title: "Drive agents across orgs in parallel",
  Stage: AgentsStage,
  endCard: {
    title: "Build & ship agents across your orgs",
    subtitle: "Link your machine and drive agents anywhere — free to start.",
  },
  run: async (d: Director) => {
    const acme = d.track("acme");
    const north = d.track("north");

    d.setOrg("acme");
    d.setPreview("acme", storefront({ banner: false, cols: 3 }));
    await d.beat(500);

    await connectDesktop(d);

    // 1) Kick off a storefront redesign on the first agent — runs in the
    //    background. When it finishes it notifies (sidebar dot).
    d.caption("Give Storefront Bot a task");
    await d.beat(900);
    await acme.user("Add a Summer Sale banner and make the product grid 4-up.");
    await d.beat(500);
    const acmeDone = acmeRedesign(d, acme)
      .then(() => d.notify("acme"))
      .catch(() => {});
    await d.beat(4200); // watch it start working + the first preview change

    // 2) Switch to another agent via the sidebar — the first keeps running.
    d.caption("Switch agents in the sidebar — work keeps running");
    await d.beat(800);
    await switchAgent(d, "north");
    d.setPreview("north", connections("stripe"));
    await d.beat(700);
    await north.user("Swap the payments MCP from Stripe to Adyen.");
    await d.beat(400);
    await northSwap(d, north);
    await d.beat(1200);

    // 3) The first agent finished while we were away — sidebar dot appears.
    await acmeDone;
    d.caption("Storefront Bot finished — see the dot on its sidebar icon");
    await d.beat(2800);

    // 4) Switch back — the dot clears and the finished work is right there.
    await switchAgent(d, "acme");
    await d.beat(1900);
    d.caption("Switch anytime — agents keep working and ping you when done");
    await d.beat(3200);
  },
};
