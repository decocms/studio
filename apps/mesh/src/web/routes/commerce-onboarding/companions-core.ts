import { getGitHubAvatarUrl } from "@deco/ui/lib/github.ts";
import type { CompanionCopy } from "./companions.ts";

export interface BindingRequirement {
  fieldKey: string;
  bindingType: string;
}

export interface CandidateConnection {
  id: string;
  app_name?: string | null;
  app_id?: string | null;
  status?: string | null;
  updated_at?: string | null;
}

/** Minimal structural subset of a registry item we read for a card. */
export interface RegistryItemLike {
  id: string;
  title?: string;
  server?: {
    name?: string;
    title?: string;
    icons?: Array<{ src?: string }>;
    repository?: string | { url?: string };
  };
  _meta?: {
    "mcp.mesh"?: {
      friendlyName?: string | null;
      friendly_name?: string | null;
      short_description?: string | null;
    };
  };
}

export interface CompanionCardModel {
  fieldKey: string;
  bindingType: string;
  registryItem: RegistryItemLike;
  title: string;
  icon: string | null;
  /** Curated headline if present, else the registry short_description. */
  headline: string | null;
  /** Curated-only; null for plain cards. */
  checks: number | null;
  bullets: string[];
  satisfied: boolean;
  candidateConnectionId: string | null;
}

type ComparisonWhere = { field: string[]; operator: "in"; value: string[] };
type WhereExpr =
  | ComparisonWhere
  | { operator: "or"; conditions: ComparisonWhere[] };

/** Extract binding requirements from a downstream MCP_CONFIGURATION state schema.
 * A property is a binding requirement when properties.__type.const is a non-empty
 * string — the binding-type source also read by getBindingInfo. Order preserved. */
export function parseBindingRequirements(
  stateSchema: Record<string, unknown>,
): BindingRequirement[] {
  const properties = stateSchema.properties as
    | Record<string, unknown>
    | undefined;
  if (!properties) return [];
  const reqs: BindingRequirement[] = [];
  for (const [fieldKey, raw] of Object.entries(properties)) {
    const schema = raw as { properties?: Record<string, unknown> } | undefined;
    const typeProp = schema?.properties?.__type as
      | { const?: unknown }
      | undefined;
    const bindingType = typeProp?.const;
    if (typeof bindingType === "string" && bindingType.length > 0) {
      reqs.push({ fieldKey, bindingType });
    }
  }
  return reqs;
}

/** Build a registry LIST `where` matching items by id-set OR server-name-set.
 * `["id"]` is the top-level column; `["name"]` maps to the virtual server_json->>'name'. */
export function buildRegistryWhere(
  ids: string[],
  names: string[],
): WhereExpr | undefined {
  const conditions: ComparisonWhere[] = [];
  if (ids.length)
    conditions.push({ field: ["id"], operator: "in", value: ids });
  if (names.length)
    conditions.push({ field: ["name"], operator: "in", value: names });
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { operator: "or", conditions };
}

/** Unwrap an MCP tool-call result. Throws with the tool's error text when
 * the result is a tool-level error (Client.callTool does NOT throw on isError). */
export function unwrapToolResult<T>(result: unknown): T {
  const r = result as {
    structuredContent?: unknown;
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  if (r.isError) {
    throw new Error(r.content?.find((c) => c.text)?.text ?? "Tool call failed");
  }
  return (r.structuredContent ?? result) as T;
}

/** Full read-modify-write merge: server overwrites configuration_state wholesale,
 * so we must send every existing key plus the new binding value. */
export function mergeBindingValue(
  state: Record<string, unknown> | null | undefined,
  fieldKey: string,
  bindingType: string,
  connectionId: string,
): Record<string, unknown> {
  return {
    ...(state ?? {}),
    [fieldKey]: { __type: bindingType, value: connectionId },
  };
}

/** Pick an existing org connection satisfying a binding by app identity:
 * app_name === bindingType OR app_id === registryAppId. Prefer active, then most recent. */
export function resolveCandidate(
  connections: CandidateConnection[],
  bindingType: string,
  registryAppId: string | undefined,
): string | null {
  const matches = connections.filter(
    (c) =>
      c.app_name === bindingType ||
      (!!registryAppId && c.app_id === registryAppId),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const rank = (c: CandidateConnection) => (c.status === "active" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
  return matches[0]!.id;
}

function cardIcon(item: RegistryItemLike): string | null {
  return (
    item.server?.icons?.[0]?.src ??
    getGitHubAvatarUrl(item.server?.repository) ??
    null
  );
}

function cardTitle(item: RegistryItemLike, fallback: string): string {
  const meta = item._meta?.["mcp.mesh"];
  return (
    meta?.friendlyName ||
    meta?.friendly_name ||
    item.title ||
    item.server?.title ||
    item.server?.name ||
    fallback
  );
}

/** The render algorithm: intersection(requirements ∧ registry), enriched by curated copy.
 * Registry availability is the gate — a requirement with no registry item is skipped. */
export function buildCompanionCards(args: {
  requirements: BindingRequirement[];
  itemsById: Record<string, RegistryItemLike>;
  itemsByName: Record<string, RegistryItemLike>;
  connections: CandidateConnection[];
  configurationState: Record<string, unknown> | null | undefined;
  curated: Record<string, CompanionCopy>;
}): CompanionCardModel[] {
  const cards: CompanionCardModel[] = [];
  for (const req of args.requirements) {
    const curatedEntry = args.curated[req.bindingType];
    const item = curatedEntry
      ? args.itemsById[curatedEntry.registryAppId]
      : args.itemsByName[req.bindingType];
    if (!item) continue; // gate: not installable → skip
    const linked = (
      args.configurationState?.[req.fieldKey] as { value?: string } | undefined
    )?.value;
    const satisfied = !!linked;
    cards.push({
      fieldKey: req.fieldKey,
      bindingType: req.bindingType,
      registryItem: item,
      title: cardTitle(item, req.bindingType),
      icon: cardIcon(item),
      headline:
        curatedEntry?.headline ??
        item._meta?.["mcp.mesh"]?.short_description ??
        null,
      checks: curatedEntry?.checks ?? null,
      bullets: curatedEntry?.bullets ?? [],
      satisfied,
      candidateConnectionId: satisfied
        ? null
        : resolveCandidate(
            args.connections,
            req.bindingType,
            curatedEntry?.registryAppId,
          ),
    });
  }
  return cards;
}
