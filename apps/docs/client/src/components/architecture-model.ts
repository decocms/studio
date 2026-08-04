// Single source of truth for the Studio architecture diagram.
// Consumed by ArchitectureDiagram.astro (static SVG, docs) and by
// scripts/gen-architecture-html.ts (standalone interactive architecture.html).
// Update the diagram HERE — both outputs derive from this file.

const TIER: Record<string, string> = {
  edge: "#94a3b8",
  web: "#22d3ee",
  api: "#38bdf8",
  worker: "#a78bfa",
  mcp: "#2dd4bf",
  file: "#a3e635",
  db: "#34d399",
  nats: "#fbbf24",
  sbx: "#fb7185",
  pub: "#fb923c",
  llm: "#f0abfc",
};

const ZONES = [
  {
    x: 24,
    y: 150,
    w: 140,
    h: 790,
    label: "Edge",
    sub: "public internet",
    stroke: "rgba(148,163,184,.30)",
    fill: "rgba(148,163,184,.03)",
  },
  {
    x: 182,
    y: 150,
    w: 992,
    h: 790,
    label: "Cloud Cluster",
    sub: "kubernetes",
    stroke: "rgba(56,189,248,.24)",
    fill: "rgba(56,189,248,.03)",
  },
];

const SUBZONES = [
  { x: 620, y: 782, w: 556, h: 150, label: "Cloud Sandbox · pod" },
];

export type Node = {
  x: number;
  y: number;
  w: number;
  h: number;
  tier: string;
  label: string;
  tag?: string;
  shape?: "cyl" | "hex";
  replicas?: boolean;
  ext?: boolean;
  role?: string;
  desc?: string;
  facts?: [string, string][];
};

const NODES: Record<string, Node> = {
  s3: {
    x: 470,
    y: 96,
    w: 128,
    h: 54,
    tier: "file",
    ext: true,
    label: "Object Store",
    tag: "s3 · external",
    role: "Blob backend",
    desc: "S3-compatible object storage behind the file routes. Holds uploads, generated assets and offloaded large payloads.",
    facts: [
      ["Type", "S3-compatible"],
      ["Behind", "file routes"],
    ],
  },
  llm: {
    x: 760,
    y: 96,
    w: 128,
    h: 54,
    tier: "llm",
    ext: true,
    label: "LLM",
    tag: "anthropic · external",
    role: "Model provider",
    desc: "Claude models (Anthropic). Called by the worker that runs the Decopilot loop. Credentials are injected per run.",
    facts: [
      ["Models", "Claude"],
      ["Called by", "worker"],
    ],
  },
  dmcp: {
    x: 1004,
    y: 96,
    w: 140,
    h: 54,
    tier: "mcp",
    ext: true,
    label: "Downstream MCP",
    tag: "tool servers · external",
    role: "MCP servers",
    desc: "The actual MCP tool servers. Reached two ways: the API's MCP proxy forwards external-client traffic here over HTTP; the worker's agent loop connects directly in-process via a PassthroughClient bridge — no HTTP hop inside Studio.",
    facts: [
      ["Reached by", "proxy (HTTP)"],
      ["+ worker", "in-process bridge"],
    ],
  },

  client: {
    x: 94,
    y: 330,
    w: 118,
    h: 58,
    tier: "edge",
    label: "Client",
    tag: "browser / mcp",
    role: "Cursor · Claude · UI",
    desc: "Browser UI and external MCP clients (Cursor, Claude, VS Code). Origin of every request — app traffic and MCP-over-HTTP.",
    facts: [
      ["Speaks", "HTTP + MCP"],
      ["Hits", "Cloudflare edge"],
    ],
  },
  cf: {
    x: 94,
    y: 510,
    w: 118,
    h: 58,
    tier: "edge",
    label: "CF",
    tag: "edge / cdn",
    role: "Cloudflare",
    desc: "Edge layer. TLS termination, static SPA caching, DDoS and bot mitigation. First hop for all traffic, including sandbox preview.",
    facts: [
      ["TLS", "terminated here"],
      ["Caches", "SPA assets"],
    ],
  },
  nlb: {
    x: 94,
    y: 690,
    w: 118,
    h: 58,
    tier: "edge",
    label: "NLB",
    tag: "l4 lb",
    role: "Network Load Balancer",
    desc: "L4 balancer fronting the cluster. Routes to the web (front-door) pods; the frontDoorLabels selector decides which pods receive ingress.",
    facts: [
      ["Layer", "L4 / TCP"],
      ["Targets", "web pods"],
      ["Cutover", "frontDoorLabels"],
    ],
  },

  web: {
    x: 305,
    y: 545,
    w: 146,
    h: 64,
    tier: "web",
    label: "Web",
    tag: "nginx · spa",
    replicas: true,
    role: "Web tier",
    desc: "nginx serving the React 19 SPA and reverse-proxying /api, /mcp, /oauth-proxy, /.well-known to the API Service. Split from the API (front-door split) so the static front door deploys and scales on its own.",
    facts: [
      ["Image", "ghcr…/studio/web"],
      ["Port", "8080"],
      ["Proxies →", "API Service"],
      ["Scales", "independently"],
    ],
  },
  api: {
    x: 485,
    y: 360,
    w: 148,
    h: 64,
    tier: "api",
    label: "API",
    tag: "hono · role=api",
    replicas: true,
    role: "App server",
    desc: "Hono server: HTTP routes, Better Auth, MCP proxy, access control. Enqueues decopilot runs onto DBOS queues and tails NATS to stream output back to the UI. Does NOT run the agent loop. Stateless.",
    facts: [
      ["Runtime", "Hono / Bun"],
      ["Role", "enqueue + serve"],
      ["State", "in Postgres"],
      ["Scales", "independently"],
    ],
  },
  worker: {
    x: 485,
    y: 645,
    w: 148,
    h: 64,
    tier: "worker",
    label: "Worker",
    tag: "role=worker · dbos",
    replicas: true,
    role: "Run executor",
    desc: "STUDIO_DISPATCH_ROLE=worker. Dequeues the DBOS queues it listens on (THREAD_GATE serial-per-thread; AUTOMATIONS per-org) via listenQueues — set by env — and runs the agent loop: streamText, model → tool → repeat, ~200 steps. Calls MCP tools in-process and the sandbox daemon for fs/git/bash. CPU-bound. Scales horizontally; pools can be split per queue to run different DBOS workflows with their own resources.",
    facts: [
      ["Drives", "the agent loop"],
      ["Queues", "DBOS listenQueues (env)"],
      ["MCP", "in-process bridge"],
      ["Scales", "horizontally · per-queue"],
    ],
  },
  mcpproxy: {
    x: 705,
    y: 300,
    w: 150,
    h: 60,
    tier: "mcp",
    label: "MCP Proxy",
    tag: "api routes",
    role: "MCP gateway (API-served)",
    desc: "API HTTP routes exposing MCP to external clients: /mcp/virtual-mcp/:id (aggregated agent), /mcp/:connectionId (single-connection proxy), /oauth-proxy/* and /.well-known. Called by external IDEs. The worker does NOT use these — it talks MCP in-process.",
    facts: [
      ["Serves", "external MCP clients"],
      ["Routes", "/mcp/* · /oauth-proxy"],
      ["Not used by", "worker"],
    ],
  },
  files: {
    x: 705,
    y: 470,
    w: 150,
    h: 60,
    tier: "file",
    label: "Files / Storage",
    tag: "api · /files /fs",
    role: "File + object-storage",
    desc: "/api/:org/files/*, uploads, object-storage presigned GET/PUT, and /api/:org/fs/* (the org-fs WebDAV backend). Called by BOTH the API (serving clients) and the worker (agent tools), and by the sandbox org-fs mounts. Backed by S3.",
    facts: [
      ["Called by", "API + Worker + Org FS"],
      ["Routes", "/files · presigned · /fs"],
      ["Backend", "S3"],
    ],
  },
  nats: {
    x: 930,
    y: 300,
    w: 124,
    h: 82,
    tier: "nats",
    shape: "hex",
    label: "NATS",
    tag: "messaging",
    role: "Live message bus",
    desc: "Live infrastructure for JetStream /stream fan-out (decopilot.stream.<thread>) to the UI and cross-pod run signals. It is separate from the dormant CloudEvents event-bus feature.",
    facts: [
      ["Fan-out", "/stream → UI"],
      ["Signals", "cross-pod runs"],
    ],
  },
  db: {
    x: 930,
    y: 505,
    w: 122,
    h: 88,
    tier: "db",
    shape: "cyl",
    label: "DB",
    tag: "postgres",
    role: "System of record",
    desc: "PostgreSQL via Kysely. Orgs, connections, vault, audit, threads + messages, sandbox_runner_state — plus the DBOS queues and workflow_status journal that make runs durable and recoverable.",
    facts: [
      ["Engine", "PostgreSQL"],
      ["ORM", "Kysely"],
      ["Holds", "state + DBOS queues"],
      ["Recovery", "DBOS journal"],
    ],
  },
  gateway: {
    x: 300,
    y: 858,
    w: 132,
    h: 54,
    tier: "edge",
    label: "Gateway",
    tag: "k8s gateway api",
    role: "Preview ingress",
    desc: "Kubernetes Gateway API (Istio) — the ingress for sandbox preview traffic. Cloudflare fronts it as the LB; the Gateway routes <handle>.preview.<domain> via an HTTPRoute to the sandbox pod's daemon (:9000).",
    facts: [
      ["Type", "Istio Gateway API"],
      ["Fronted by", "Cloudflare (LB)"],
      ["Routes", "*.preview.<domain> → daemon"],
    ],
  },
  daemonctl: {
    x: 710,
    y: 852,
    w: 158,
    h: 60,
    tier: "sbx",
    label: "Daemon API",
    tag: "protected · /_sandbox/*",
    role: "Sandbox control API",
    desc: "The in-pod daemon's protected control surface (Bearer DAEMON_TOKEN, port 9000): fs ops (read/write/edit/bash/grep), git (status/diff/publish), exec scripts, setup (clone→install→start), tasks, and SSE events. Reached over k8s port-forward. Called by the worker (agent fs/git/bash tools) and the API (UI setup + events). Relays org-fs config to the sidecar via /_sandbox/orgfs-config.",
    facts: [
      ["Auth", "Bearer DAEMON_TOKEN"],
      ["Port", "9000"],
      ["Called by", "Worker + API"],
      ["Ops", "fs · git · bash · setup"],
    ],
  },
  orgfsc: {
    x: 900,
    y: 852,
    w: 132,
    h: 56,
    tier: "file",
    label: "Org FS",
    tag: "mount · sidecar",
    role: "Org filesystem mount",
    desc: "The org filesystem mounted into the cloud sandbox at <appRoot>/org/<volume>. A privileged SIDECAR container runs rclone (NFS/FUSE) against the daemon's loopback WebDAV; config is delivered post-bind via /_sandbox/orgfs-config (warm-pool claims reject spec.env). Backend: /api/:org/fs/* → S3.",
    facts: [
      ["Mount", "rclone → WebDAV"],
      ["Cluster", "privileged sidecar"],
      ["Backend", "/api/:org/fs → S3"],
    ],
  },
  daemonprev: {
    x: 1085,
    y: 852,
    w: 152,
    h: 60,
    tier: "pub",
    label: "Preview",
    tag: "public",
    role: "Public dev-server preview",
    desc: "The daemon's catch-all reverse-proxy serving the running dev server — the live app preview. Public by handle (the subdomain is the secret); /_sandbox/* is actively rejected here. Reached at <handle>.preview.<domain> through Cloudflare (LB) → the k8s Gateway (HTTPRoute) → the daemon. Injects HMR bootstrap.",
    facts: [
      ["Auth", "none — handle = secret"],
      ["Front", "CF → k8s Gateway"],
      ["URL", "handle.preview.<domain>"],
    ],
  },
};

// from, to, kind
const EDGES: [string, string, string][] = [
  ["client", "cf", "req"],
  ["cf", "nlb", "req"],
  ["nlb", "web", "req"],
  ["web", "api", "req"],
  ["api", "mcpproxy", "ctrl"],
  ["mcpproxy", "dmcp", "ctrl"],
  ["worker", "dmcp", "inproc"],
  ["api", "files", "ctrl"],
  ["worker", "files", "ctrl"],
  ["files", "s3", "ctrl"],
  ["api", "worker", "ctrl"],
  ["api", "db", "ctrl"],
  ["worker", "db", "ctrl"],
  ["api", "nats", "ctrl"],
  ["worker", "nats", "ctrl"],
  ["worker", "llm", "model"],
  ["worker", "daemonctl", "ctrl"],
  ["api", "daemonctl", "ctrl"],
  ["cf", "gateway", "public"],
  ["gateway", "daemonprev", "public"],
  ["daemonctl", "orgfsc", "ctrl"],
  ["orgfsc", "files", "ctrl"],
];

const EDGE_STYLE: Record<
  string,
  { stroke: string; dash?: string; w: number; op: number }
> = {
  req: { stroke: "#465268", w: 1.5, op: 0.55 },
  ctrl: { stroke: "#465268", w: 1.5, op: 0.5 },
  model: { stroke: TIER.llm, dash: "2 5", w: 1.4, op: 0.45 },
  mcp: { stroke: "#52607a", dash: "3 6", w: 1.4, op: 0.4 },
  inproc: { stroke: TIER.mcp, dash: "2 4", w: 1.4, op: 0.5 },
  public: { stroke: TIER.pub, dash: "6 5", w: 1.5, op: 0.6 },
};

// manual margin routes for long cross-diagram edges
const ROUTES: Record<string, { x: number; y: number }[]> = {
  "gateway>daemonprev": [
    { x: 300, y: 885 },
    { x: 300, y: 1002 },
    { x: 1085, y: 1002 },
    { x: 1085, y: 882 },
  ],
};

// ordered traces for the interactive html (ignored by the static SVG)
const SCENARIOS = [
  {
    id: "req",
    label: "Request path",
    color: TIER.web,
    steps: [
      ["client", "cf"],
      ["cf", "nlb"],
      ["nlb", "web"],
      ["web", "api"],
      ["api", "db"],
    ],
  },
  {
    id: "mcp",
    label: "External MCP client",
    color: TIER.mcp,
    steps: [
      ["client", "cf"],
      ["cf", "nlb"],
      ["nlb", "web"],
      ["web", "api"],
      ["api", "mcpproxy"],
      ["mcpproxy", "dmcp"],
    ],
  },
  {
    id: "cloud",
    label: "Cloud decopilot run",
    color: TIER.worker,
    steps: [
      ["web", "api"],
      ["api", "worker"],
      ["worker", "llm"],
      ["worker", "dmcp"],
      ["worker", "files"],
      ["files", "s3"],
      ["worker", "daemonctl"],
      ["worker", "db"],
      ["worker", "nats"],
      ["nats", "api"],
    ],
  },
  {
    id: "sandbox",
    label: "Sandbox preview + control",
    color: TIER.sbx,
    steps: [
      ["client", "cf"],
      ["cf", "gateway"],
      ["gateway", "daemonprev"],
      ["api", "daemonctl"],
      ["worker", "daemonctl"],
    ],
  },
  {
    id: "orgfs",
    label: "Org filesystem mount",
    color: TIER.file,
    steps: [
      ["daemonctl", "orgfsc"],
      ["orgfsc", "files"],
      ["files", "s3"],
    ],
  },
];

const LEGEND: [string, string][] = [
  ["edge", "Edge"],
  ["web", "Web"],
  ["api", "API"],
  ["worker", "Worker"],
  ["mcp", "MCP"],
  ["file", "Files"],
  ["db", "Postgres"],
  ["nats", "NATS"],
  ["sbx", "Sandbox"],
  ["pub", "Preview"],
  ["llm", "LLM"],
];

// ---------- layout math ----------
const NORMAL: Record<string, [number, number]> = {
  r: [1, 0],
  l: [-1, 0],
  t: [0, -1],
  b: [0, 1],
};
function sides(a: Node, b: Node): [string, string] {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? ["r", "l"] : ["l", "r"];
  return dy > 0 ? ["b", "t"] : ["t", "b"];
}
function anchor(n: Node, side: string, f: number) {
  const hw = n.w / 2,
    hh = n.h / 2;
  if (side === "r") return { x: n.x + hw, y: n.y - hh + f * n.h, n: NORMAL.r };
  if (side === "l") return { x: n.x - hw, y: n.y - hh + f * n.h, n: NORMAL.l };
  if (side === "t") return { x: n.x - hw + f * n.w, y: n.y - hh, n: NORMAL.t };
  return { x: n.x - hw + f * n.w, y: n.y + hh, n: NORMAL.b };
}
function roundedPath(pts: { x: number; y: number }[], r = 16) {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i],
      a = pts[i - 1],
      b = pts[i + 1];
    const v1 = { x: p.x - a.x, y: p.y - a.y },
      v2 = { x: b.x - p.x, y: b.y - p.y };
    const l1 = Math.hypot(v1.x, v1.y) || 1,
      l2 = Math.hypot(v2.x, v2.y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const s = { x: p.x - (v1.x / l1) * rr, y: p.y - (v1.y / l1) * rr };
    const e = { x: p.x + (v2.x / l2) * rr, y: p.y + (v2.y / l2) * rr };
    d += ` L${s.x.toFixed(1)},${s.y.toFixed(1)} Q${p.x},${p.y} ${e.x.toFixed(1)},${e.y.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x},${last.y}`;
  return d;
}

type EM = {
  from: string;
  to: string;
  kind: string;
  sa: string;
  sb: string;
  fa?: number;
  fb?: number;
  routed?: { x: number; y: number }[];
};

function shapePath(n: Node): string | null {
  if (n.shape === "cyl") {
    const w = n.w,
      h = n.h,
      rx = w / 2,
      ry = 10;
    return `M${-rx},${-h / 2 + ry} a${rx},${ry} 0 0 1 ${w},0 v${h - 2 * ry} a${rx},${ry} 0 0 1 ${-w},0 Z`;
  }
  if (n.shape === "hex") {
    const w = n.w / 2,
      h = n.h / 2,
      c = 18;
    return `M${-w + c},${-h} H${w - c} L${w},0 L${w - c},${h} H${-w + c} L${-w},0 Z`;
  }
  return null;
}

// Resolve all geometry from the data above. Returned objects are plain and
// JSON-serialisable so the generator can embed them straight into the html.
export function computeLayout() {
  const edgeMeta: EM[] = [];
  const buckets: Record<string, { i: number; end: "a" | "b" }[]> = {};
  EDGES.forEach((e, i) => {
    const routed = ROUTES[e[0] + ">" + e[1]];
    const [af, bf] = sides(NODES[e[0]], NODES[e[1]]);
    edgeMeta.push({ from: e[0], to: e[1], kind: e[2], sa: af, sb: bf, routed });
    if (routed) return;
    (buckets[e[0] + "|" + af] ||= []).push({ i, end: "a" });
    (buckets[e[1] + "|" + bf] ||= []).push({ i, end: "b" });
  });
  Object.entries(buckets).forEach(([key, list]) => {
    const side = key.split("|")[1];
    list.sort((p, q) => {
      const op =
        p.end === "a" ? NODES[edgeMeta[p.i].to] : NODES[edgeMeta[p.i].from];
      const oq =
        q.end === "a" ? NODES[edgeMeta[q.i].to] : NODES[edgeMeta[q.i].from];
      return side === "t" || side === "b" ? op.x - oq.x : op.y - oq.y;
    });
    const n = list.length;
    list.forEach((it, k) => {
      const f = (k + 1) / (n + 1);
      if (it.end === "a") edgeMeta[it.i].fa = f;
      else edgeMeta[it.i].fb = f;
    });
  });
  const pathFor = (m: EM) => {
    if (m.routed) return roundedPath(m.routed);
    const A = NODES[m.from],
      B = NODES[m.to];
    const p1 = anchor(A, m.sa, m.fa ?? 0.5),
      p2 = anchor(B, m.sb, m.fb ?? 0.5);
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const k = Math.min(160, Math.max(48, dist * 0.4));
    const c1 = { x: p1.x + p1.n[0] * k, y: p1.y + p1.n[1] * k };
    const c2 = { x: p2.x + p2.n[0] * k, y: p2.y + p2.n[1] * k };
    return `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  };

  const edges = edgeMeta.map((m) => ({
    from: m.from,
    to: m.to,
    kind: m.kind,
    d: pathFor(m),
    ...EDGE_STYLE[m.kind],
  }));
  const nodes = Object.entries(NODES).map(([id, n]) => ({
    id,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    tier: n.tier,
    col: TIER[n.tier],
    label: n.label,
    tag: n.tag ?? null,
    shape: shapePath(n),
    replicas: !!n.replicas,
    ext: !!n.ext,
    role: n.role ?? "",
    desc: n.desc ?? "",
    facts: n.facts ?? [],
  }));
  return {
    zones: ZONES,
    subzones: SUBZONES,
    nodes,
    edges,
    legend: LEGEND.map(([t, name]) => ({ name, col: TIER[t] })),
    scenarios: SCENARIOS,
  };
}
