/**
 * A local MCP server that ships UI tools (MCP Apps), so the app-views half of
 * the project settings has something real to list, pin and open.
 *
 * Studio decides a tool is a view by `_meta.ui.resourceUri` on `tools/list`
 * (`getUIResourceUri`), then reads that `ui://` resource for the HTML it
 * iframes. Both come from here, over streamable HTTP JSON-RPC — the same wire
 * a hosted MCP app would use, so nothing in Studio is in dev mode.
 *
 * The apps are hand-rolled against the ext-apps postMessage protocol rather
 * than the SDK: the injected CSP is `default-src 'none'` with inline scripts
 * allowed, so an app cannot fetch a bundle, and each one is a single file.
 *
 * Run:  bun run scripts/dev-mcp-app.ts [--port 8789]
 * Wire: bun run scripts/dev-seed-mcp-app-connection.ts
 */

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k!, v ?? "true"] as const;
    }),
);

const PORT = Number(args.get("port") ?? 8789);
const PROTOCOL_VERSION = "2026-01-26";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const SERVER_NAME = "Store Insights";

// --- data the apps render ----------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const rnd = lcg(90210);

const CHANNELS = ["Organic", "Paid search", "Email", "Social", "Direct"];
const STATUSES = ["paid", "handling", "shipped", "delivered", "canceled"];

function ordersTimeline() {
  const hours = Array.from({ length: 24 }, (_, i) => 23 - i).reverse();
  return {
    updatedAt: new Date().toISOString(),
    total: 0,
    series: hours.map((h) => {
      const at = new Date(Date.now() - h * 3_600_000);
      const orders = Math.round(18 + rnd() * 42);
      return {
        hour: `${String(at.getHours()).padStart(2, "0")}h`,
        orders,
        revenue: Math.round(orders * (180 + rnd() * 140)),
      };
    }),
    recent: Array.from({ length: 6 }, (_, i) => ({
      id: `1002${400 + i * 7}`,
      status: STATUSES[Math.floor(rnd() * STATUSES.length)]!,
      channel: CHANNELS[Math.floor(rnd() * CHANNELS.length)]!,
      total: Math.round(120 + rnd() * 900),
      minutesAgo: Math.round(4 + i * 11 + rnd() * 9),
    })),
  };
}

function stockAlerts() {
  const SKUS = [
    ["Tênis Runner Pro 42", "TRP-42"],
    ["Camiseta Dry Fit P", "CDF-P"],
    ["Jaqueta Corta-Vento M", "JCV-M"],
    ["Meia Esportiva Kit 3", "MEK-3"],
    ["Boné Trail", "BNT-U"],
    ["Legging Compressão G", "LCG-G"],
  ] as const;
  return {
    updatedAt: new Date().toISOString(),
    items: SKUS.map(([name, sku], i) => {
      const onHand = Math.round(rnd() * 34);
      const daily = 3 + Math.round(rnd() * 9);
      return {
        name,
        sku,
        onHand,
        dailyVelocity: daily,
        daysLeft: Math.max(0, Math.round((onHand / daily) * 10) / 10),
        severity: onHand === 0 ? "out" : onHand < daily * 3 ? "low" : "ok",
        pendingOrders: i % 3 === 0 ? Math.round(rnd() * 12) : 0,
      };
    }),
  };
}

function salesFunnel() {
  const sessions = 48_120;
  const product = Math.round(sessions * 0.41);
  const cart = Math.round(product * 0.23);
  const checkout = Math.round(cart * 0.62);
  const orders = Math.round(checkout * 0.71);
  return {
    updatedAt: new Date().toISOString(),
    steps: [
      { label: "Sessões", value: sessions },
      { label: "Página de produto", value: product },
      { label: "Carrinho", value: cart },
      { label: "Checkout", value: checkout },
      { label: "Pedidos", value: orders },
    ],
    byChannel: CHANNELS.map((channel) => ({
      channel,
      sessions: Math.round(sessions * (0.08 + rnd() * 0.3)),
      conversion: Math.round((0.6 + rnd() * 2.4) * 100) / 100,
    })),
  };
}

// --- the apps ---------------------------------------------------------------

/**
 * The ext-apps handshake, verbatim and minimal: request `ui/initialize`,
 * announce `ui/notifications/initialized`, then report our height so the host
 * can size the iframe. `callTool` reuses the same JSON-RPC channel, so the app
 * gets its data from the server through the host, like a real one.
 */
const BRIDGE_JS = String.raw`
const pending = new Map();
let nextId = 1;
function send(msg) { window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*"); }
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(method + " timed out"));
    }, 15000);
  });
}
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.jsonrpc !== "2.0" || msg.id == null) return;
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
});
function reportSize() {
  const el = document.documentElement;
  send({ method: "ui/notifications/size-changed", params: {
    width: Math.ceil(window.innerWidth),
    height: Math.ceil(el.getBoundingClientRect().height),
  }});
}
async function connect(name) {
  await request("ui/initialize", {
    appInfo: { name, version: "0.1.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26",
  });
  send({ method: "ui/notifications/initialized" });
  reportSize();
  new ResizeObserver(reportSize).observe(document.documentElement);
}
function callTool(name, args) {
  return request("tools/call", { name, arguments: args ?? {} });
}
`;

const APP_CSS = String.raw`
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 20px;
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
  color: #1c1c1a; background: #fbfbf9;
}
h1 { margin: 0; font-size: 15px; font-weight: 600; }
p.sub { margin: 2px 0 18px; font-size: 13px; color: #77776f; }
.grid { display: grid; gap: 12px; }
.cards { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.card {
  background: #fff; border: 1px solid #ececea; border-radius: 12px; padding: 14px;
}
.kpi { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
.label { font-size: 12px; color: #77776f; }
.bars { display: flex; align-items: flex-end; gap: 4px; height: 120px; margin-top: 6px; }
.bars > div { flex: 1; background: #d7e9c9; border-radius: 4px 4px 0 0; min-height: 2px; }
.bars > div:last-child { background: #8fbf5f; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; font-size: 13px; border-bottom: 1px solid #f1f1ef; }
th { font-weight: 500; color: #77776f; font-size: 12px; }
tr:last-child td { border-bottom: 0; }
.pill {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 12px; background: #f1f1ef; color: #55554f;
}
.pill.warn { background: #fdf0d5; color: #8a6414; }
.pill.bad { background: #fbe2e0; color: #97302a; }
.pill.good { background: #e5f1da; color: #4a6b2c; }
.funnel > div { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.funnel .track { height: 26px; background: #eaf2e1; border-radius: 6px; }
.err { color: #97302a; font-size: 13px; }
`;

function appHtml(title: string, subtitle: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${APP_CSS}</style>
</head>
<body>
<h1>${title}</h1>
<p class="sub">${subtitle}</p>
<div id="root"><p class="label">Carregando…</p></div>
<script type="module">
${BRIDGE_JS}
const root = document.getElementById("root");
const nf = new Intl.NumberFormat("pt-BR");
const money = (v) => "R$ " + nf.format(v);
try {
  await connect(${JSON.stringify(title)});
${script}
} catch (err) {
  root.innerHTML = '<p class="err">' + err.message + "</p>";
}
reportSize();
</script>
</body>
</html>`;
}

const ORDERS_APP = appHtml(
  "Pedidos por hora",
  "Últimas 24 horas, direto do MCP.",
  String.raw`
  const res = await callTool("STORE_ORDERS_TIMELINE");
  const data = res.structuredContent;
  const max = Math.max(...data.series.map((s) => s.orders));
  const orders = data.series.reduce((a, s) => a + s.orders, 0);
  const revenue = data.series.reduce((a, s) => a + s.revenue, 0);
  root.innerHTML =
    '<div class="grid cards">' +
      '<div class="card"><div class="label">Pedidos</div><div class="kpi">' + nf.format(orders) + "</div></div>" +
      '<div class="card"><div class="label">Receita</div><div class="kpi">' + money(revenue) + "</div></div>" +
      '<div class="card"><div class="label">Ticket médio</div><div class="kpi">' + money(Math.round(revenue / orders)) + "</div></div>" +
    "</div>" +
    '<div class="card" style="margin-top:12px"><div class="label">Pedidos por hora</div><div class="bars">' +
      data.series.map((s) => '<div style="height:' + Math.round((s.orders / max) * 100) + '%" title="' + s.hour + ": " + s.orders + '"></div>').join("") +
    "</div></div>" +
    '<div class="card" style="margin-top:12px"><table><thead><tr><th>Pedido</th><th>Status</th><th>Canal</th><th>Total</th><th>Quando</th></tr></thead><tbody>' +
      data.recent.map((o) =>
        "<tr><td>#" + o.id + '</td><td><span class="pill">' + o.status + "</span></td><td>" + o.channel +
        "</td><td>" + money(o.total) + "</td><td>" + o.minutesAgo + " min</td></tr>").join("") +
    "</tbody></table></div>";
`,
);

const STOCK_APP = appHtml(
  "Alertas de estoque",
  "SKUs com cobertura abaixo de 3 dias.",
  String.raw`
  const res = await callTool("STORE_STOCK_ALERTS");
  const items = res.structuredContent.items;
  const cls = { out: "bad", low: "warn", ok: "good" };
  const critical = items.filter((i) => i.severity !== "ok").length;
  root.innerHTML =
    '<div class="grid cards">' +
      '<div class="card"><div class="label">SKUs em risco</div><div class="kpi">' + critical + "</div></div>" +
      '<div class="card"><div class="label">Sem estoque</div><div class="kpi">' + items.filter((i) => i.severity === "out").length + "</div></div>" +
      '<div class="card"><div class="label">Pedidos travados</div><div class="kpi">' + items.reduce((a, i) => a + i.pendingOrders, 0) + "</div></div>" +
    "</div>" +
    '<div class="card" style="margin-top:12px"><table><thead><tr><th>Produto</th><th>SKU</th><th>Em estoque</th><th>Venda/dia</th><th>Dias</th><th></th></tr></thead><tbody>' +
      items.map((i) =>
        "<tr><td>" + i.name + "</td><td>" + i.sku + "</td><td>" + i.onHand + "</td><td>" + i.dailyVelocity +
        "</td><td>" + i.daysLeft + '</td><td><span class="pill ' + cls[i.severity] + '">' + i.severity + "</span></td></tr>").join("") +
    "</tbody></table></div>";
`,
);

const FUNNEL_APP = appHtml(
  "Funil de vendas",
  "Sessões até pedido, por canal.",
  String.raw`
  const res = await callTool("STORE_SALES_FUNNEL");
  const data = res.structuredContent;
  const top = data.steps[0].value;
  root.innerHTML =
    '<div class="card funnel">' +
      data.steps.map((s) =>
        "<div><div style=\"width:150px\" class=\"label\">" + s.label + "</div>" +
        '<div class="track" style="width:' + Math.round((s.value / top) * 100) + '%"></div>' +
        "<div>" + nf.format(s.value) + "</div></div>").join("") +
    "</div>" +
    '<div class="card" style="margin-top:12px"><table><thead><tr><th>Canal</th><th>Sessões</th><th>Conversão</th></tr></thead><tbody>' +
      data.byChannel.map((c) =>
        "<tr><td>" + c.channel + "</td><td>" + nf.format(c.sessions) + "</td><td>" + c.conversion.toFixed(2) + "%</td></tr>").join("") +
    "</tbody></table></div>";
`,
);

// --- MCP surface ------------------------------------------------------------

interface UiTool {
  name: string;
  title: string;
  description: string;
  resourceUri?: string;
  html?: string;
  data: () => unknown;
}

const TOOLS: UiTool[] = [
  {
    name: "STORE_ORDERS_TIMELINE",
    title: "Pedidos por hora",
    description: "Volume e receita de pedidos nas últimas 24 horas.",
    resourceUri: "ui://store-insights/orders-timeline.html",
    html: ORDERS_APP,
    data: ordersTimeline,
  },
  {
    name: "STORE_STOCK_ALERTS",
    title: "Alertas de estoque",
    description: "SKUs sem estoque ou com menos de 3 dias de cobertura.",
    resourceUri: "ui://store-insights/stock-alerts.html",
    html: STOCK_APP,
    data: stockAlerts,
  },
  {
    name: "STORE_SALES_FUNNEL",
    title: "Funil de vendas",
    description: "Sessões, carrinho, checkout e pedidos por canal.",
    resourceUri: "ui://store-insights/sales-funnel.html",
    html: FUNNEL_APP,
    data: salesFunnel,
  },
  {
    // No `resourceUri`: proves Studio lists only the tools that carry a view.
    name: "STORE_SEARCH_ORDERS",
    title: "Buscar pedidos",
    description: "Busca pedidos por id, email ou status.",
    data: () => ({ items: [], note: "dev stub" }),
  },
];

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
const toolByUri = new Map(
  TOOLS.filter((t) => t.resourceUri).map((t) => [t.resourceUri!, t]),
);

function listedTool(tool: UiTool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    ...(tool.resourceUri
      ? { _meta: { ui: { resourceUri: tool.resourceUri } } }
      : {}),
  };
}

type JsonRpcId = string | number | null;

function result(id: JsonRpcId, value: unknown) {
  return { jsonrpc: "2.0" as const, id, result: value };
}

function failure(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function handle(message: {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}) {
  const id = message.id ?? null;
  const params = message.params ?? {};

  switch (message.method) {
    case "initialize":
      return result(id, {
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: {} },
        serverInfo: { name: SERVER_NAME, version: "0.1.0" },
      });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS.map(listedTool) });
    case "tools/call": {
      const tool = toolByName.get(String(params.name ?? ""));
      if (!tool) return failure(id, -32602, `Unknown tool: ${params.name}`);
      const data = tool.data();
      return result(id, {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        ...(tool.resourceUri
          ? { _meta: { ui: { resourceUri: tool.resourceUri } } }
          : {}),
      });
    }
    case "resources/list":
      return result(id, {
        resources: TOOLS.filter((t) => t.resourceUri).map((t) => ({
          uri: t.resourceUri!,
          name: t.title,
          mimeType: RESOURCE_MIME_TYPE,
        })),
      });
    case "resources/templates/list":
      return result(id, { resourceTemplates: [] });
    case "prompts/list":
      return result(id, { prompts: [] });
    case "resources/read": {
      const tool = toolByUri.get(String(params.uri ?? ""));
      if (!tool) return failure(id, -32602, `Unknown resource: ${params.uri}`);
      return result(id, {
        contents: [
          {
            uri: tool.resourceUri!,
            mimeType: RESOURCE_MIME_TYPE,
            text: tool.html!,
          },
        ],
      });
    }
    default:
      return failure(id, -32601, `Method not found: ${message.method}`);
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, tools: TOOLS.length });
    }
    if (url.pathname !== "/mcp") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // No SSE stream: every response is the reply to its own POST.
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return Response.json(failure(null, -32700, "Parse error"), {
        status: 400,
      });
    }

    const batch = Array.isArray(payload) ? payload : [payload];
    const replies = batch
      .map((m) => m as { id?: JsonRpcId; method?: string })
      // A notification has no id and gets no reply.
      .filter((m) => m.id != null)
      .map(handle);

    if (replies.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(payload) ? replies : replies[0]);
  },
});

console.log(
  `dev mcp app server on http://localhost:${server.port}/mcp\n` +
    TOOLS.map(
      (t) =>
        `  ${t.name}${t.resourceUri ? ` → ${t.resourceUri}` : " (no view)"}`,
    ).join("\n"),
);
