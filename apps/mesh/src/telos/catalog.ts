import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getWellKnownRegistryConnection } from "@decocms/mesh-sdk";
import type { ToolTarget } from "./target";

// The catalog of REAL, connectable apps a goal may reference. A goal tool is only
// ever drawn from here, so it always exists and is connectable in-place via its
// `appName` (useInstallFromRegistry.installByBinding). The LLM proposes freely;
// validateTools drops anything not in the catalog — cited-or-dropped, for goals.
export interface CatalogApp {
  // Registry binding id used to install the app, e.g. "@deco/github".
  appName: string;
  label: string;
  // Lowercase keywords matched against a connection's app_name/slug/title.
  match: string[];
  icon?: string;
}

// Fallback set when the live store fetch fails — kept tiny and well-known so the
// goal is never empty/broken. The live Deco Store (below) is the primary source.
const CURATED: CatalogApp[] = [
  { appName: "@deco/github", label: "GitHub", match: ["github"] },
  { appName: "@deco/gmail", label: "Gmail", match: ["gmail", "google mail"] },
  { appName: "@deco/linear", label: "Linear", match: ["linear"] },
  { appName: "@deco/shopify", label: "Shopify", match: ["shopify"] },
  { appName: "@deco/slack", label: "Slack", match: ["slack"] },
];

const norm = (s: string): string => s.toLowerCase().trim();
const uniq = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))];

// Strip a scope prefix so "@deco/github" also matches a connection named "github".
const bareName = (appName: string): string =>
  appName.replace(/^@/, "").split("/").pop() ?? appName;

interface RegistryItemLike {
  id?: string;
  name?: string;
  title?: string;
  server?: { name?: string; icons?: Array<{ src?: string }> };
  _meta?: {
    "mcp.mesh"?: {
      scopeName?: string;
      appName?: string;
      friendly_name?: string | null;
    };
  };
}

function toCatalogApp(item: RegistryItemLike): CatalogApp | null {
  const mesh = item._meta?.["mcp.mesh"];
  const rawApp = mesh?.appName ?? item.server?.name ?? item.name;
  if (!rawApp) return null;
  // COLLECTION_REGISTRY_APP_GET resolves by the SCOPED name, e.g. "deco/mcp-github".
  // Qualify the bare app name with its scope when it isn't already scoped.
  const appName = rawApp.includes("/")
    ? rawApp
    : mesh?.scopeName
      ? `${mesh.scopeName}/${rawApp}`
      : rawApp;
  const label =
    mesh?.friendly_name ?? item.title ?? item.server?.name ?? rawApp;
  if (!label) return null;
  return {
    appName,
    label,
    match: uniq(
      [appName, bareName(appName), rawApp, label, item.server?.name ?? ""].map(
        norm,
      ),
    ),
    icon: item.server?.icons?.[0]?.src,
  };
}

// Fetch the live Deco Store catalog over MCP. The store is a public HTTP MCP
// endpoint (no auth needed to list), so this works from a background job. Best-
// effort: returns [] on any failure (network, timeout, shape) so callers fall back.
async function fetchStoreCatalog(orgId: string): Promise<CatalogApp[]> {
  const url = getWellKnownRegistryConnection(orgId).connection_url;
  if (!url) return [];
  const client = new Client({ name: "telos-onboarding", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    const result = await withTimeout(
      (async () => {
        await client.connect(transport);
        return client.callTool({
          name: "COLLECTION_REGISTRY_APP_LIST",
          arguments: { limit: 100 },
        });
      })(),
      12_000,
    );
    const structured = (result as { structuredContent?: { items?: unknown } })
      .structuredContent;
    const items = Array.isArray(structured?.items)
      ? (structured.items as RegistryItemLike[])
      : [];
    const apps = items
      .map(toCatalogApp)
      .filter((a): a is CatalogApp => a !== null);
    // Dedupe by appName.
    const bySlug = new Map<string, CatalogApp>();
    for (const a of apps) if (!bySlug.has(a.appName)) bySlug.set(a.appName, a);
    return [...bySlug.values()];
  } catch (err) {
    console.warn("[telos] live store catalog fetch failed", err);
    return [];
  } finally {
    await client.close().catch(() => {});
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("catalog fetch timeout")), ms),
    ),
  ]);
}

// The catalog to constrain a goal to: the live Deco Store, falling back to the
// curated set if the fetch yields nothing. Never throws.
export async function resolveCatalog(orgId: string): Promise<CatalogApp[]> {
  const live = await fetchStoreCatalog(orgId);
  return live.length ? live : CURATED;
}

// A compact list the synthesis prompt shows the model so it picks real apps.
export function catalogForPrompt(catalog: CatalogApp[]): string {
  return catalog.map((a) => a.label).join(", ");
}

// Map a proposed tool to a real catalog app, or null if it isn't one. Tolerant of
// how the model phrased it, strict on whether the app actually exists.
function resolveOne(
  proposed: { label?: string; match?: string[] },
  catalog: CatalogApp[],
): CatalogApp | null {
  const needles = [proposed.label ?? "", ...(proposed.match ?? [])]
    .map(norm)
    .filter(Boolean);
  if (needles.length === 0) return null;
  return (
    catalog.find((app) => {
      const hay = [app.appName, bareName(app.appName), app.label, ...app.match]
        .map(norm)
        .filter(Boolean);
      return needles.some((n) =>
        hay.some((h) => h === n || h.includes(n) || n.includes(h)),
      );
    }) ?? null
  );
}

// Validate the model's proposed tools against the catalog: keep only real apps
// (with canonical appName/label/match/icon), deduped. Never invents.
export function validateTools(
  proposed: Array<{ label?: string; match?: string[] }>,
  catalog: CatalogApp[],
): ToolTarget[] {
  const out: ToolTarget[] = [];
  const seen = new Set<string>();
  for (const p of proposed) {
    const app = resolveOne(p, catalog);
    if (!app || seen.has(app.appName)) continue;
    seen.add(app.appName);
    out.push({
      label: app.label,
      appName: app.appName,
      match: app.match,
      icon: app.icon,
    });
  }
  return out;
}
