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
    name: "Vela Agent",
    sub: "runs the team",
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
    id: "vela-ops",
    name: "Store Ops",
    sub: "sales · analytics",
    glyph: "O",
    tile: "bg-pink-200 text-pink-950",
  },
  // Settings is an AGENT — always the bottom one, scoped to where you are.
  // There is no settings screen: each settings section is an MCP app it
  // renders in the preview panel. Chat + preview, everywhere.
  {
    id: "vela-settings",
    name: "Settings",
    sub: "this org, as apps",
    glyph: "⚙",
    tile: "bg-muted text-muted-foreground",
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
  if (level === "org") return "Vela Agent";
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

/** The Members section rendered as an MCP app in the preview panel — settings
 *  has no special screen; it's apps inside the Settings agent's preview. */
function settingsApp({ rafaAdmin }: { rafaAdmin: boolean }): string {
  const row = (name: string, email: string, role: string, hot = false) =>
    `<div class="row"><div class="who"><div class="ava">${name[0]}</div><div><div class="nm">${name}</div><div class="em">${email}</div></div></div><span class="role ${hot ? "hot" : ""}">${role}</span></div>`;
  return `<!doctype html><html><head><meta charset="utf8"><style>
*{box-sizing:border-box;margin:0;font-family:Inter,system-ui,sans-serif}
body{background:#fff;color:#101828;display:flex;min-height:100vh}
nav{width:180px;border-right:1px solid #f0f1f3;padding:18px 10px}
nav .t{font-size:11px;font-weight:600;color:#98a2b3;text-transform:uppercase;letter-spacing:.04em;padding:0 8px 8px}
nav a{display:block;padding:7px 8px;border-radius:8px;font-size:13px;color:#475467;text-decoration:none}
nav a.on{background:#f2f4f7;color:#101828;font-weight:600}
main{flex:1;padding:26px 28px}
h1{font-size:18px;margin-bottom:2px}
.sub{font-size:12px;color:#667085;margin-bottom:18px}
.row{display:flex;align-items:center;justify-content:space-between;border:1px solid #f0f1f3;border-radius:10px;padding:10px 12px;margin-bottom:8px}
.who{display:flex;align-items:center;gap:10px}
.ava{width:30px;height:30px;border-radius:8px;background:#f2f4f7;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#475467}
.nm{font-size:13px;font-weight:600}.em{font-size:11px;color:#98a2b3}
.role{font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;background:#f2f4f7;color:#475467}
.role.hot{background:#ecfccb;color:#3f6212}
</style></head><body>
<nav><div class="t">Settings</div>
<a>General</a><a class="on">Members</a><a>Connections</a><a>Billing</a><a>Notifications</a>
</nav>
<main><h1>Members</h1><div class="sub">Who can act in Vela Store — every row is a tool call away.</div>
${row("Gui", "gui@vela.shop", "Owner", true)}
${row("Rafa", "rafa@vela.shop", rafaAdmin ? "Admin ✓" : "Member", rafaAdmin)}
${row("Cami", "cami@vela.shop", "Member")}
${row("Dex", "dex@vela.shop", "Member")}
<div style="margin-top:16px;border:1px dashed #d0d5dd;border-radius:10px;padding:12px;display:flex;gap:8px;align-items:center">
<span style="flex:1;font-size:13px;color:#98a2b3">Invite your team — emails, comma separated…</span>
<span style="background:#101828;color:#fff;font-size:12px;font-weight:600;padding:7px 14px;border-radius:8px">Invite</span>
</div>
</main></body></html>`;
}

/** Tiny inline SVG sparkline for the dashboard HTML apps. */
function sparkSvg(points: number[], color: string): string {
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const pts = points
    .map(
      (v, i) =>
        `${((i / (points.length - 1)) * 60).toFixed(1)},${(18 - 2 - ((v - min) / span) * 14).toFixed(1)}`,
    )
    .join(" ");
  return `<svg viewBox="0 0 60 18" width="60" height="18" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`;
}

const DASH_STYLE = `*{box-sizing:border-box;margin:0;font-family:Inter,system-ui,sans-serif}
body{background:#fafafa;color:#101828;padding:16px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.kpi{background:#fff;border:1px solid #f0f1f3;border-radius:12px;padding:10px 12px}
.kpi .l{font-size:11px;color:#667085;display:flex;gap:6px;align-items:center}
.kpi .an{font-size:9px;font-weight:700;color:#dc2626;letter-spacing:.03em}
.kpi .v{font-size:20px;font-weight:700;margin:2px 0}
.kpi .d{font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px}
.kpi .d.bad{color:#dc2626}.kpi .d.good{color:#16a34a}
.card{background:#fff;border:1px solid #f0f1f3;border-radius:12px;padding:12px 14px;margin-bottom:12px}
.card h2{font-size:13px;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.card h2 a{font-size:11px;color:#667085;font-weight:500;text-decoration:none}
.it{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:7px 0;border-top:1px solid #f6f7f9;font-size:12px}
.it .t{font-weight:600;display:flex;align-items:center;gap:6px}
.it .s{font-size:11px;color:#98a2b3;margin-top:1px}
.it .when{font-size:11px;color:#98a2b3;white-space:nowrap}
.chip{font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px}
.chip.crit{background:#fee4e2;color:#b42318}.chip.high{background:#fef0c7;color:#b54708}.chip.med{background:#f2f4f7;color:#475467}
.chip.rev{background:#fef0c7;color:#b54708}.chip.rdy{background:#dcfce7;color:#166534}
.assign{font-size:11px;font-weight:600;color:#101828;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:99px;display:inline-block}
.dot.crit{background:#dc2626}.dot.high{background:#f59e0b}.dot.med{background:#98a2b3}`;

/** The org pilot's home: an OPERATIONS dashboard, not a site preview —
 *  KPIs with anomalies flagged, diagnosed anomalies, agent-proposed
 *  opportunities, and the review queue. */
function orgDashboard(): string {
  const kpi = (
    l: string,
    v: string,
    d: string,
    bad: boolean,
    pts: number[],
    anomaly = false,
  ) =>
    `<div class="kpi"><div class="l">${l}${anomaly ? '<span class="an">⚡ ANOMALY</span>' : ""}</div><div class="v">${v}</div><div class="d ${bad ? "bad" : "good"}">${bad ? "↘" : "↗"} ${d} ${sparkSvg(pts, bad ? "#dc2626" : "#16a34a")}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf8"><style>${DASH_STYLE}</style></head><body>
<div class="kpis">
${kpi("Conversion rate", "2.41%", "8.4%", true, [8, 7, 7, 6, 5, 4, 3], true)}
${kpi("Revenue (today)", "R$118k", "6.2%", true, [7, 6, 6, 5, 5, 4, 4])}
${kpi("LCP (PDP p75)", "1.9s", "12%", true, [2, 3, 3, 4, 5, 6, 7])}
${kpi("Organic sessions", "412k", "4.1%", false, [3, 4, 4, 5, 5, 6, 7])}
${kpi("Error rate", "0.6%", "0.2%", false, [6, 5, 5, 4, 4, 3, 3])}
${kpi("Open opportunities", "3", "1", false, [2, 3, 3, 4, 4, 5, 5])}
</div>
<div class="card"><h2>⚡ Anomalies detected · last 24h <a>View all →</a></h2>
<div class="it"><div><div class="t"><span class="dot crit"></span>Conversion on /knits PLP dropped 23% <span class="chip crit">critical</span></div><div class="s">conv 3.1% → 2.4% · ≈ R$48k/day at risk · ~6% of paid-traffic sessions</div></div><span class="when">2h ago</span></div>
<div class="it"><div><div class="t"><span class="dot high"></span>PDP crash spike after CMS publish <span class="chip high">high</span></div><div class="s">273 errors/min at peak · long tail over ~48h from CDN/browser cache</div></div><span class="when">6h ago</span></div>
<div class="it"><div><div class="t"><span class="dot med"></span>GA4 purchase event double-firing <span class="chip med">medium</span></div><div class="s">~6% of orders report 2 purchase events · revenue overstated ≈ 5.8%</div></div><span class="when">yesterday</span></div>
</div>
<div class="card"><h2>✦ Opportunities proposed by agents <a>Open board →</a></h2>
<div class="it"><div><div class="t">Serve product images as AVIF/WebP</div><div class="s">Performance · −0.9s LCP (est.)</div></div><span class="assign">Assign →</span></div>
<div class="it"><div><div class="t">De-dupe GA4 purchase event by transaction_id</div><div class="s">Tracking · fix 5.8% revenue overstatement</div></div><span class="assign">Assign →</span></div>
<div class="it"><div><div class="t">Index search synonyms (singular/plural)</div><div class="s">SEO · recover 0-result searches</div></div><span class="assign">Assign →</span></div>
</div>
<div class="card"><h2>⎇ Awaiting your review</h2>
<div class="it"><div><div class="t">#482 fix(vtex): strip GA tracking params <span class="chip rev">review</span></div><div class="s">In review · Developer Agent</div></div></div>
<div class="it"><div><div class="t">#479 perf(pdp): preload hero image <span class="chip rdy">ready</span></div><div class="s">Ready to deploy · Camila Souza</div></div></div>
</div>
</body></html>`;
}

/** Minified SLO strip — every agent is a LOOP over goals, and this card is
 *  the loop made visible: each goal is an SLI with a target, an error budget,
 *  and a trend. Incident opens on breach, closes on recovery; the agent
 *  pursues these continuously and remembers what worked. */
function sloCard(
  title: string,
  rows: {
    name: string;
    target: string;
    sli: string;
    budget: string;
    state: "ok" | "risk";
    pts: number[];
  }[],
  memory: string,
): string {
  const COLOR = { ok: "#4ade80", risk: "#fbbf24" } as const;
  const row = (r: (typeof rows)[number]) => {
    const c = COLOR[r.state];
    return `<div class="sr"><div class="sn">${r.name}<span>target: ${r.target}</span></div><div class="sb"><i style="background:${c};width:${r.sli}"></i></div><b style="color:${c}">${r.budget}</b>${sparkSvg(r.pts, c)}</div>`;
  };
  const healthy = rows.filter((r) => r.state === "ok").length;
  const risk = rows.length - healthy;
  return `<div class="slo"><div class="sh"><span>◈ ${title} · goals</span><span class="st"><em class="ok">${healthy} healthy</em>${risk ? `<em class="rk">${risk} at risk</em>` : ""}</span></div>${rows.map(row).join("")}<div class="sf">agent loop — pursues these continuously · ${memory}</div></div>`;
}

const SLO_STYLE = `
.slo{background:#101418;border-radius:12px;padding:12px 14px;margin-bottom:12px;font-family:ui-monospace,SFMono-Regular,monospace}
.sh{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.sh>span:first-child{color:#f9fafb;font-size:11px;font-weight:700}
.st em{font-style:normal;font-size:9px;border-radius:99px;padding:2px 7px;margin-left:5px}
.st .ok{background:#14532d;color:#86efac}.st .rk{background:#451a03;color:#fcd34d}
.sr{display:grid;grid-template-columns:1fr 90px 44px 64px;gap:10px;align-items:center;padding:6px 0;border-top:1px solid #1c2128}
.sn{color:#e5e7eb;font-size:10px;font-weight:600}
.sn span{display:block;color:#6b7280;font-size:9px;font-weight:400;margin-top:1px}
.sb{background:#1c2128;border-radius:99px;height:5px;overflow:hidden}.sb i{display:block;height:100%;border-radius:99px}
.sr b{font-size:10px;text-align:right}
.sf{color:#6b7280;font-size:9px;margin-top:8px;border-top:1px solid #1c2128;padding-top:7px}`;

/** Store Ops' own app: yesterday's sales, revenue trend, top products. */
function storeOpsApp(): string {
  const bar = (h: number, hot = false) =>
    `<div style="flex:1;background:${hot ? "#4d7c0f" : "#e4e7ec"};border-radius:4px 4px 0 0;height:${h}%"></div>`;
  const prod = (name: string, rev: string, share: string) =>
    `<div class="it"><div><div class="t">${name}</div><div class="s">${share} of revenue</div></div><span class="assign">${rev}</span></div>`;
  return `<!doctype html><html><head><meta charset="utf8"><style>${DASH_STYLE}${SLO_STYLE}
.chart{display:flex;align-items:flex-end;gap:6px;height:90px;padding-top:6px}
.lbl{display:flex;gap:6px;font-size:10px;color:#98a2b3;margin-top:4px}
.lbl span{flex:1;text-align:center}</style></head><body>
<div class="kpis">
${`<div class="kpi"><div class="l">Orders · yesterday</div><div class="v">412</div><div class="d good">↗ 38%</div></div>`}
${`<div class="kpi"><div class="l">Revenue · yesterday</div><div class="v">R$96k</div><div class="d good">↗ 44%</div></div>`}
${`<div class="kpi"><div class="l">Avg. order</div><div class="v">R$233</div><div class="d good">↗ 5%</div></div>`}
</div>
${sloCard(
  "Store Ops",
  [
    {
      name: "Daily recap delivered by 8am",
      target: "99%",
      sli: "96%",
      budget: "87%",
      state: "ok",
      pts: [5, 5, 6, 5, 6, 6, 6],
    },
    {
      name: "Conversion rate",
      target: "≥ 2.0%",
      sli: "92%",
      budget: "64%",
      state: "ok",
      pts: [4, 4, 5, 4, 5, 6, 6],
    },
    {
      name: "Stockout alert time",
      target: "< 15 min",
      sli: "78%",
      budget: "22%",
      state: "risk",
      pts: [6, 6, 5, 5, 4, 4, 3],
    },
  ],
  "memory: 214 learnings",
)}
<div class="card"><h2>Revenue · last 7 days</h2>
<div class="chart">${bar(38)}${bar(42)}${bar(35)}${bar(48)}${bar(52)}${bar(61)}${bar(96, true)}</div>
<div class="lbl"><span>Sat</span><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span></div>
</div>
<div class="card"><h2>Top products · yesterday</h2>
${prod("Winter Parka — the drop", "R$28k", "29%")}
${prod("Heavyweight Knit", "R$14k", "15%")}
${prod("Wool Scarf", "R$9k", "9%")}
</div>
<div class="card"><h2>Channels</h2>
${prod("Organic search", "R$44k", "46%")}
${prod("Paid social", "R$30k", "31%")}
${prod("Direct", "R$22k", "23%")}
</div>
</body></html>`;
}

/** The tasks board: every proposed action is a card — kanban, like Jira
 *  without the ceremony. Assign to an agent or a person. Styled like the
 *  product: soft column wells, white cards, brand chips. */
function tasksKanban(): string {
  const card = (
    id: string,
    chip: string,
    chipCls: string,
    title: string,
    impact: string,
    who: string,
    agent: boolean,
  ) =>
    `<div class="tk"><div class="th"><span class="tid">${id}</span><span class="chip ${chipCls}">${chip}</span></div><div class="tt">${title}</div><div class="ti">↗ ${impact}</div><div class="tw"><span class="av ${agent ? "bot" : "hum"}">${agent ? "🤖" : who.slice(0, 1)}</span>${who}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf8"><style>${DASH_STYLE}
body{padding:16px;background:#fafafa}
h1{font-size:16px;letter-spacing:-.01em;margin-bottom:2px}
.sub{font-size:11px;color:#667085;margin-bottom:14px}
.board{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.col{background:#f2f2f0;border-radius:14px;padding:8px}
.col h3{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#667085;font-weight:600;margin:2px 4px 8px;display:flex;justify-content:space-between;align-items:center}
.col h3 b{background:#fff;border-radius:99px;padding:1px 7px;font-weight:600;color:#475467}
.tk{background:#fff;border:1px solid #ececec;border-radius:12px;padding:10px;margin-bottom:8px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.th{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.tid{font-size:9px;color:#98a2b3;font-family:ui-monospace,monospace}
.tt{font-size:12px;font-weight:600;line-height:1.3;letter-spacing:-.01em}
.ti{font-size:10px;color:#3f6212;font-weight:600;margin-top:4px}
.tw{display:flex;align-items:center;gap:5px;font-size:10px;color:#667085;margin-top:8px}
.av{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:99px;font-size:8px;font-weight:700}
.av.bot{background:#ecfccb}
.av.hum{background:#e0e7ff;color:#3730a3}
.chip{font-size:9px;border-radius:99px;padding:2px 7px;font-weight:600}
.chip.anom{background:#fee4e2;color:#b42318}.chip.diag{background:#ede9fe;color:#5b21b6}.chip.jira{background:#f2f4f7;color:#475467}</style></head><body>
<h1>Tasks</h1><div class="sub">Every proposed action lands here as a card — from diagnostics, anomalies, or your backlog. Assign to an agent or a person.</div>
<div class="board">
<div class="col"><h3>Proposed <b>2</b></h3>
${card("T-488", "anomaly", "anom", "De-dupe GA4 purchase event by transaction_id", "Fix 5.8% revenue overstatement", "Unassigned", false)}
${card("T-489", "diagnostic", "diag", "Index search synonyms (singular/plural)", "Recover 0-result searches", "Unassigned", false)}
</div>
<div class="col"><h3>In progress <b>2</b></h3>
${card("T-475", "diagnostic", "diag", "Add canonical tag to PLP template", "+18k organic sessions/mo", "SEO Agent", true)}
${card("T-486", "jira", "jira", "Show shipping cost earlier in cart", "−4pp cart abandonment (est.)", "Guilherme R.", false)}
</div>
<div class="col"><h3>In review <b>1</b></h3>
${card("T-482", "anomaly", "anom", "Strip GA tracking params before VTEX IS lookup", "+R$48k/day recovered", "Developer Agent", true)}
</div>
<div class="col"><h3>Ready to deploy <b>1</b></h3>
${card("T-479", "diagnostic", "diag", "Preload PDP hero image + fetchpriority", "+1.8% conversion (est.)", "Camila Souza", false)}
</div>
</div>
</body></html>`;
}

// ============================================================================
// Shell chrome — real toolbar look: breadcrumb + Share right beside it
// ============================================================================

/** Write several ui inputs at once — the stage's own navigation primitive,
 *  shared by the Director's script AND real clicks after the demo ends. */
function setInputs(stores: DemoStores, patch: Record<string, string>) {
  stores.ui.update((s) => ({ ...s, inputs: { ...s.inputs, ...patch } }));
}

/** The right preview app for a scope — each agent owns its own MCP app.
 *  Used by real clicks (explore mode) so the preview always matches. */
function previewPatch(
  stores: DemoStores,
  agentId: string,
): Record<string, string> {
  const shipped = stores.ui.get().inputs.shipped === "1";
  const rafaAdmin = stores.ui.get().inputs.rafa === "1";
  if (agentId === "vela-settings") {
    return {
      "preview:vela": settingsApp({ rafaAdmin }),
      "preview-url": "vela · settings/members",
    };
  }
  if (agentId === "vela-ops") {
    return { "preview:vela": storeOpsApp(), "preview-url": "vela · sales" };
  }
  if (agentId === "vela-bot") {
    return {
      "preview:vela": velaPreview({ winter: shipped }),
      "preview-url": "vela.shop",
    };
  }
  // The pilot's home is the OPERATIONS dashboard, not the site.
  return { "preview:vela": orgDashboard(), "preview-url": "vela · operations" };
}

function Crumb({
  target,
  active,
  onClick,
  children,
}: {
  target: string;
  active: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-demo-target={target}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors",
        active
          ? "font-medium text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
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
      <Crumb
        target="crumb:home"
        active={level === "home"}
        onClick={() => setInputs(stores, { level: "home", agent: "" })}
      >
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
          <Crumb
            target="crumb:org"
            active={level === "org"}
            onClick={() =>
              setInputs(stores, {
                level: "org",
                agent: "",
                ...previewPatch(stores, "vela"),
              })
            }
          >
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
          onClick={() =>
            setInputs(stores, {
              share: stores.ui.get().inputs.share === "open" ? "" : "open",
            })
          }
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
  onClick,
}: {
  target?: string;
  active: boolean;
  busy?: boolean;
  tile: string;
  glyph: React.ReactNode;
  name: string;
  sub?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      data-demo-target={target}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-300",
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
    </button>
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

/** "Invite your team" — always present at the sidebar's bottom, in every
 *  scope. Setup is one person's job; everyone else just gets invited. */
function InviteTeamRow() {
  return (
    <button
      type="button"
      data-demo-target="invite-team"
      className="mt-auto flex items-center gap-2.5 rounded-lg border border-dashed border-border px-2 py-2 text-left text-[13px] font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
    >
      <span className="flex size-6 items-center justify-center rounded-md bg-muted text-[13px] text-muted-foreground">
        +
      </span>
      Invite your team
    </button>
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
          <SidebarSectionLabel>Agents {ORGS.length + 2}</SidebarSectionLabel>
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
          {/* Your teams ARE agents in your personal org — they list here too. */}
          {ORGS.map((o) => (
            <SidebarOrgRow key={o.id} stores={stores} org={o} />
          ))}
          {/* Settings is an agent — always at the bottom, personal scope. */}
          <SidebarRow
            active={false}
            tile="bg-muted text-muted-foreground"
            glyph="⚙"
            name="Settings"
            sub="your deco"
          />
        </>
      ) : (
        <>
          {/* Same thread UI inside the org — see what teammates are on.
              A real box (NOT display:contents) so the ghost cursor can aim. */}
          <div
            data-demo-target="team-threads"
            className="flex flex-col gap-0.5"
          >
            <SidebarSectionLabel>Team threads</SidebarSectionLabel>
            {VELA_TEAM_THREADS.map((t) => (
              <ThreadRow key={t.title} {...t} />
            ))}
          </div>
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
      <InviteTeamRow />
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
      onClick={
        org.id === "vela"
          ? () =>
              setInputs(stores, {
                level: "org",
                agent: "",
                ...previewPatch(stores, "vela"),
              })
          : undefined
      }
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
      onClick={() =>
        agent.id === "vela"
          ? setInputs(stores, {
              level: "org",
              agent: "",
              ...previewPatch(stores, "vela"),
            })
          : setInputs(stores, {
              level: "agent",
              agent: agent.id,
              ...previewPatch(stores, agent.id),
            })
      }
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
    <button
      type="button"
      data-demo-target={`org-card:${org.id}`}
      onClick={
        org.id === "vela"
          ? () =>
              setInputs(stores, {
                level: "org",
                agent: "",
                ...previewPatch(stores, "vela"),
              })
          : undefined
      }
      className="flex w-full flex-col rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent/40"
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
          className="mt-2.5 w-full border-t border-border pt-2 text-xs leading-relaxed text-muted-foreground animate-in fade-in duration-500"
        >
          {status}
        </div>
      )}
    </button>
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
            Your teams
          </div>
          {ORGS.map((o) => (
            <OrgCard key={o.id} stores={stores} org={o} />
          ))}
          <div className="px-1 text-[11px] leading-relaxed text-muted-foreground/60">
            Each team is a connection and an agent in your personal deco — it
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

/** The agent's MCP apps — each entry is one app UI this agent can render in
 *  the preview. The agent decides which apps it offers (and which is default);
 *  the switcher lives top-right of the preview chrome, like in Studio. */
const VELA_APPS: {
  label: string;
  url: string;
  html: (s: DemoStores) => string;
}[] = [
  {
    label: "Operations",
    url: "vela · operations",
    html: () => orgDashboard(),
  },
  {
    label: "Site",
    url: "vela.shop",
    html: (s) => velaPreview({ winter: s.ui.get().inputs.shipped === "1" }),
  },
  { label: "Sales", url: "vela · sales", html: () => storeOpsApp() },
  { label: "Tasks", url: "vela · tasks", html: () => tasksKanban() },
  {
    label: "Members",
    url: "vela · settings/members",
    html: (s) => settingsApp({ rafaAdmin: s.ui.get().inputs.rafa === "1" }),
  },
];

function OrgLevel({
  stores,
  activeAgent,
}: {
  stores: DemoStores;
  activeAgent: string;
}) {
  const previewHtml = useDemoInput(stores, "preview:vela");
  const previewUrl = useDemoInput(stores, "preview-url") || "vela.shop";
  const apps = VELA_APPS.map((app) => ({
    label: app.label,
    active: previewUrl === app.url,
    onClick: () =>
      setInputs(stores, {
        "preview:vela": app.html(stores),
        "preview-url": app.url,
      }),
  }));
  return (
    // Chat 40 / preview 60 — the app UI is the star at org/agent level.
    <div className="grid min-h-0 flex-1 grid-cols-[2fr_3fr]">
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
        <PreviewFrame url={previewUrl} html={previewHtml} apps={apps} />
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

| Team | Status | Needs you |
| --- | --- | --- |
| **Vela Store** | Winter Drop assets approved, hero not shipped | **Yes — ship it** |
| **Aurora Coffee** | Subscription churn down 12% after winback flow | No |
| **Atlas Labs** | All green — 3 PRs merged overnight | No |

One thing needs you: **Vela's Winter Drop hero** is approved and waiting.`;

function orgPilotCall(org: Org, summary: string, latencyMs: number) {
  return genericTool({
    name: "ask_team_agent",
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
  const deco = d.track("deco").setSender({ name: "Decopilot", logo: true });

  await d.caption("This is deco Studio — the home for your AI agents!");
  await d.beat(3300);

  await d.caption(
    "Every morning, your agents report on what's new — and what needs you",
  );
  await say(d, deco, "Good morning!");
  await d.beat(400);
  await deco.think(
    "I'll ask each team's agent for its overnight report, then rank what actually needs Gui.",
    { cps: 85 },
  );

  await d.caption("Your deco asks each team's agent — in parallel");
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
  // The brief ends in an ACTION, not a paragraph — the card lands WITH the
  // digest, not after a pause: a button straight to the org that needs you.
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
  await d.caption(
    "Your agents handle the routine — you make the calls that matter",
  );
  await d.beat(5000); // hold: read the table + the card together
}

async function hopIntoVela(d: Director) {
  await d.caption("The card takes you straight into the team context");
  d.showCursor();
  await d.beat(600);
  await d.click("org-cta");
  d.setInput("level", "org");
  d.setOrg("vela");
  d.hideCursor();

  // You land in a thread where Vela's pilot has ALREADY asked the question —
  // answer it and work proceeds. No re-explaining context.
  const vela = d.track("vela").setSender({
    name: "Vela Agent",
    glyph: "V",
    tile: "bg-lime-200 text-lime-950",
  });
  d.setInput("thread:vela", "1"); // the thread appears under My threads
  // The greeting streams IMMEDIATELY on landing (over line 5's narration) so
  // the chat column is never a blank card while the dashboard loads beside it.
  await d.beat(300);
  await vela.stream(
    "Morning! The Winter Drop hero is ready — assets approved, QA passed. Ship it now?",
    { cps: 60 },
  );
  vela.endTurn();
  await d.caption(
    "You land on its operations — everything the agent watches, live",
  );
  await d.beat(3400); // read the dashboard + the agent's question

  // Answer immediately — the urgency is the point. No sidebar detours.
  await d.caption("You say ship it — that's the whole job");
  await say(d, vela, "Yes — ship it.");
  await d.beat(400);
  await vela.think(
    "Swap the hero, audit the page before it ships, fix anything that regressed, then deploy.",
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
      latencyMs: 1800,
    }),
  );
  // The preview swaps from the ops dashboard to the site to SHOW the change.
  d.setInput("preview-url", "vela.shop");
  d.setPreview("vela", velaPreview({ winter: true }));
  d.setInput("shipped", "1");

  // The pilot audits on its own, catches the regression, and DELEGATES the
  // fix to its own specialist — the user never has to know what LCP is.
  // The line narrates WHILE the audit/fix run, not after them.
  await d.caption(
    "It audits before shipping, finds a regression — and fixes it itself",
  );
  await vela.tool(
    genericTool({
      name: "audit_page",
      input: { url: "vela.shop", checks: ["performance", "seo"] },
      output: { result: "LCP 1.9s — new hero image 840KB, no preload" },
      latencyMs: 1500,
    }),
  );
  await vela.stream(
    "The new hero slowed the page down. Sending it to Storefront Bot before we ship.",
    { cps: 55 },
  );
  await vela.tool(
    genericTool({
      name: "subtask",
      input: { agent: "Storefront Bot", task: "optimize the new hero asset" },
      output: { result: "hero.webp 168KB · preload added · LCP 1.2s ✓" },
      latencyMs: 1400,
    }),
  );
  await vela.tool(
    genericTool({
      name: "deploy",
      output: { result: "vela.shop · v87 live" },
      latencyMs: 1000,
    }),
  );

  // Shipped → who sees it: teammates' threads live in the same sidebar.
  // Narrates over the ✅ message landing, then the sidebar click.
  await d.caption(
    "Your teammates see it land — their threads live right beside yours",
  );
  await vela.stream(
    "✅ Live on vela.shop — Winter Drop hero, fast (LCP **1.2s**). I've queued the follow-ups on the board.",
    { cps: 55 },
  );
  vela.endTurn();
  await d.beat(400);
  d.showCursor();
  await d.click("team-threads");
  await d.beat(2200);
  d.hideCursor();

  // → and where the follow-ups went: the agent's Tasks app. The cursor
  // clicks the app switcher (top right of the preview) to make it explicit
  // that this board is ONE of the agent's MCP apps.
  await d.caption(
    "Every follow-up becomes a card — assigned to an agent, or a person",
  );
  d.showCursor();
  await d.click("app:tasks");
  d.setInput("preview-url", "vela · tasks");
  d.setPreview("vela", tasksKanban());
  d.hideCursor();
  await d.beat(4200);
}

const SALES_RECAP = `Yesterday on vela.shop:

| | Yesterday | vs. prior day |
| --- | --- | --- |
| Orders | **412** | ▲ 38% |
| Revenue | **R$96k** | ▲ 44% |
| Avg. order | **R$233** | ▲ 5% |

Top seller: the **Winter Parka** — the drop is converting at 2.1× your baseline. Want this recap every morning?`;

async function zoomIntoAgent(d: Director) {
  await d.caption(
    "Go one level deeper — every level runs an agent loop, with goals and memory",
  );
  d.showCursor();
  await d.beat(400);
  await d.click("agent:vela-ops");
  d.setInput("level", "agent");
  d.setInput("agent", "vela-ops");
  // Store Ops has its OWN app in the preview — sales data, not the site.
  d.setInput("preview-url", "vela · sales");
  d.setPreview("vela", storeOpsApp());
  d.hideCursor();
  await d.beat(900);

  const ops = d.track("vela-ops").setSender({
    name: "Store Ops",
    glyph: "O",
    tile: "bg-pink-200 text-pink-950",
  });
  await say(d, ops, "How were yesterday's sales?");
  await d.beat(300);
  await ops.tool(
    genericTool({
      name: "query_orders",
      input: { range: "yesterday", compare: "prior_day" },
      output: { result: "412 orders · R$96k · AOV R$233" },
      latencyMs: 1200,
    }),
  );
  await ops.stream(SALES_RECAP, { instant: true });
  ops.endTurn();
  await d.beat(2200); // hold the sales table + the goals card
}

async function shareOpsToWhatsApp(d: Director) {
  // Share is demonstrated where it's most visceral: THIS sales agent, on
  // your phone. Every breadcrumb level mints an MCP URL for its scope.
  await d.caption(
    "Every scope is an MCP URL — take this exact agent to WhatsApp",
  );
  d.showCursor();
  await d.beat(500);
  await d.click("share-button");
  d.setInput("share", "open");
  await d.beat(800);
  d.hideCursor();
  await d.beat(4100); // read the URL + client chips (narration covers this)
  d.setInput("share", "");
  await d.beat(300);
}

/** Settings is an agent, its screens are MCP apps in the preview — chat +
 *  preview is the ONE pattern; settings gets no special screen. */
async function settingsAsAgent(d: Director) {
  await d.caption(
    "Even Settings is an agent — its screens are just apps in the preview",
  );
  d.showCursor();
  await d.beat(500);
  await d.click("agent:vela-settings");
  d.setInput("level", "agent");
  d.setInput("agent", "vela-settings");
  d.setInput("preview-url", "vela · settings/members");
  d.setPreview("vela", settingsApp({ rafaAdmin: false }));
  d.hideCursor();
  await d.beat(1000);

  const st = d.track("vela-settings").setSender({
    name: "Settings",
    glyph: "⚙",
    tile: "bg-muted text-muted-foreground",
  });
  await say(d, st, "Make Rafa an admin.");
  await d.beat(300);
  await st.tool(
    genericTool({
      name: "update_member",
      input: { member: "rafa@vela.shop", role: "admin" },
      output: { result: "Rafa · member → admin" },
      latencyMs: 1500,
    }),
  );
  d.setPreview("vela", settingsApp({ rafaAdmin: true }));
  d.setInput("rafa", "1");
  await st.stream("Done — Rafa is an **admin** now. Anything else?", {
    cps: 44,
  });
  st.endTurn();
  await d.beat(900); // let the Members app update land
}

async function backHome(d: Director) {
  await d.caption("And the logo always takes you back home — to your agents");
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
    "Vela's Winter Drop is live and fast. Every agent logged what it learned today. Nothing else needs you — go have your coffee. ☕",
    { cps: 44 },
  );
  deco.endTurn();
  await d.caption(
    "It's agents all the way down — same intelligence, only the context changes",
  );
  // Must outlast the closing clip — markEnded() clears the caption AND
  // stops the audio, so a short beat here crops the last line.
  await d.beat(5400);
}

export const turtlesScenario: Scenario = {
  id: "turtles",
  title: "Your deco — it's agents all the way down",
  Stage: TurtlesStage,
  endCard: {
    title: "It's agents all the way down",
    subtitle:
      "Your deco, your teams, their agents — one product, one URL per scope.",
  },
  run: async (d: Director) => {
    d.setInput("level", "home");
    // Entering an org lands on its OPERATIONS dashboard, not a site preview.
    d.setPreview("vela", orgDashboard());
    d.setInput("preview-url", "vela · operations");
    await d.beat(600);

    await goodMorning(d);
    await hopIntoVela(d);
    await zoomIntoAgent(d);
    await shareOpsToWhatsApp(d);
    await settingsAsAgent(d);
    await backHome(d);
  },
};
