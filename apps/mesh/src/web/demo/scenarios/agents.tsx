/**
 * Scenario 2 — Studio as a web Conductor: drive work across orgs in parallel.
 *
 * One workspace: chat on the left, a live PREVIEW on the right. The viewer
 * kicks off a storefront redesign in one org, switches to a second org to swap
 * an MCP, then returns to the first — where the redesign finished in the
 * background. Demonstrates: parallel requests, org switching, and seeing the
 * other work being done. Uses the REAL chat; the preview is an isolated iframe.
 */
import { cn } from "@deco/ui/lib/utils.ts";
import { Chat } from "@/web/components/chat";
import { DemoChatStreamProvider } from "../demo-chat-stream";
import { DemoTopBar, PreviewFrame } from "../chrome";
import { DemoLinkDialog, ITermWindow } from "../link-flow";
import { genericTool } from "../message-builders";
import { useCurrentOrg, useDemoInput, useTrackBusy } from "../use-demo-stores";
import type { Director, Track } from "../director";
import type { DemoStores } from "../director-stores";
import type { Scenario } from "../types";

const ORGS = [
  { id: "acme", org: "Acme Store", agent: "Storefront Agent", url: "acme.com" },
  {
    id: "north",
    org: "Northwind",
    agent: "Payments Agent",
    url: "app.northwind.com/connections",
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

function OrgTab({
  stores,
  id,
  label,
  active,
}: {
  stores: DemoStores;
  id: string;
  label: string;
  active: boolean;
}) {
  const busy = useTrackBusy(stores, id);
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground",
      )}
    >
      {label}
      {busy && !active && (
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
      )}
    </span>
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
  const current = useCurrentOrg(stores) ?? ORGS[0].id;
  const meta = ORGS.find((o) => o.id === current) ?? ORGS[0];
  const previewHtml = useDemoInput(stores, `preview:${current}`);

  return (
    <div className="flex h-full flex-col">
      <DemoTopBar
        org={meta.org}
        agent={meta.agent}
        left={
          <div className="ml-3 flex items-center gap-1 rounded-lg border border-border p-0.5">
            {ORGS.map((o) => (
              <OrgTab
                key={o.id}
                stores={stores}
                id={o.id}
                label={o.org}
                active={o.id === current}
              />
            ))}
          </div>
        }
        right={<LinkButton stores={stores} />}
      />
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-3">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <DemoChatStreamProvider key={current} store={stores.getChat(current)}>
            <Chat className="bg-card">
              <Chat.Messages />
            </Chat>
          </DemoChatStreamProvider>
        </div>
        <PreviewFrame url={meta.url} html={previewHtml} />
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
  d.showCursor();
  d.caption("Link your machine — drive local Claude Code from the web");
  await d.wait(600);
  await d.click("link-button");
  d.setInput("link", "waiting"); // modal opens
  await d.wait(900);

  d.setInput("iterm", "open"); // iTerm window appears
  d.setInput("iterm:text", "");
  await d.type("iterm:text", "$ bunx decocms link", { cps: 22 });
  await d.wait(500);
  d.setInput("iterm:text", ITERM_AUTH);
  await d.wait(850);
  d.setInput("iterm:text", ITERM_LINKED);
  await d.wait(1100);

  d.setInput("iterm", "min"); // dev minimizes the terminal
  d.hideCursor();
  await d.wait(800);
  d.setInput("link", "connected"); // modal flips to connected
  await d.wait(1700);
  d.setInput("link", ""); // close modal
  d.setInput("iterm", ""); // unmount terminal
  await d.wait(400);
}

/** Acme storefront redesign — runs in the background while the viewer is away. */
async function acmeRedesign(d: Director, t: Track) {
  await t.think(
    "I'll add a Summer Sale hero banner, then widen the product grid to 4-up.",
  );
  await t.stream("Adding the Summer Sale banner and refreshing the hero.");
  await t.tool(codeTool("edit_section", "hero → banner + bold headline", 2400));
  d.setPreview("acme", storefront({ banner: true, cols: 3 }));
  await t.stream("Now widening the product grid to four columns.");
  await t.tool(codeTool("update_layout", "product grid → 4 columns", 2200));
  d.setPreview("acme", storefront({ banner: true, cols: 4 }));
  await t.tool(codeTool("build", "vite build · 0 errors", 2200));
  await t.tool(codeTool("deploy", "acme.com · v43 live", 1700));
  await t.stream("✅ Live on acme.com — new banner + 4-up grid.");
  t.endTurn();
}

/** Northwind MCP swap — done while Acme keeps building. */
async function northSwap(d: Director, t: Track) {
  await t.think(
    "Swap the payments MCP: disconnect Stripe, connect Adyen, re-run checkout tests.",
  );
  await t.stream("Swapping the payments MCP from Stripe to Adyen.");
  await t.tool(codeTool("disconnect_mcp", "Stripe · removed", 1600));
  await t.tool(codeTool("connect_mcp", "Adyen · connected", 1900));
  d.setPreview("north", connections("adyen"));
  await t.tool(codeTool("run_tests", "checkout smoke · 6 passed", 2200));
  await t.stream("✅ Adyen is now live for checkout.");
  t.endTurn();
}

export const agentsScenario: Scenario = {
  id: "agents",
  title: "Drive agents across orgs in parallel",
  Stage: AgentsStage,
  run: async (d: Director) => {
    const acme = d.track("acme");
    const north = d.track("north");

    d.setOrg("acme");
    d.setPreview("acme", storefront({ banner: false, cols: 3 }));

    await connectDesktop(d);

    d.caption("Start in Acme — ask the agent to redesign the storefront");
    await d.wait(500);
    await acme.user("Add a Summer Sale banner and make the product grid 4-up.");

    // Kick Acme off in the BACKGROUND — we don't await it yet. Swallow the
    // abort rejection so an unmount mid-flight doesn't surface as unhandled.
    const acmeDone = acmeRedesign(d, acme).catch(() => {});
    await d.wait(3600);

    // Switch orgs while Acme keeps working (its tab pulses).
    d.setOrg("north");
    d.setPreview("north", connections("stripe"));
    d.caption("Switch to Northwind — Acme keeps building in the background");
    await d.wait(700);
    await north.user("Swap the payments MCP from Stripe to Adyen.");
    await northSwap(d, north);
    await d.wait(900);

    // Back to Acme — the redesign finished while we were away.
    d.setOrg("acme");
    d.caption("Back in Acme — the redesign finished while you were away");
    await acmeDone;
    await d.wait(1200);
    d.caption("Parallel work across orgs — switch context, nothing waits");
    await d.wait(2200);
  },
};
