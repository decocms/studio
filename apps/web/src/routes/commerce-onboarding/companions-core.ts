import { getGitHubAvatarUrl } from "@/utils/github.ts";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import {
  getStudioMcpMetadata,
  type StudioMcpMetadataContainer,
} from "@decocms/shared/registry/metadata";
import type { TFunction } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import type { CompanionCopy } from "./companions.ts";

export interface BindingRequirement {
  fieldKey: string;
  bindingType: string;
}

export interface CandidateConnection {
  id: string;
  app_name?: string | null;
  app_id?: string | null;
  connection_token?: string | null;
  oauth_config?: unknown | null;
  configuration_state?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
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
  _meta?: StudioMcpMetadataContainer;
}

export interface CompanionCardModel {
  fieldKey: string;
  bindingType: string;
  registryItem: RegistryItemLike;
  title: string;
  icon: string | null;
  /** Curated headline if present, else the registry short_description. */
  headline: string | null;
  /** Curated business-area tag (e.g. "Funil"); null for plain cards. */
  area: string | null;
  bullets: string[];
  /** The binding is linked to a connection (or SA-verified). Note: linked does
   *  NOT imply usable — see {@link CompanionCardModel.configured}. */
  satisfied: boolean;
  /** The linked binding has everything it needs to produce data (credentials
   *  entered, repo/property picked, or SA-verified). A card can be `satisfied`
   *  but not `configured` — e.g. VTEX linked with no account yet — in which case
   *  it must read as "needs configuration", never "connected". */
  configured: boolean;
  /** This source is mandatory for a useful report; the rest only enrich it.
   *  Drives the required/optional grouping and the continue gate. */
  required: boolean;
  candidateConnectionId: string | null;
  linkedConnectionId: string | null;
  configurationState: Record<string, unknown> | null;
  /** Which lane satisfied this card: "oauth" (Studio-vault companion connection)
   *  or "sa" (shared service-account verified binding in commerce-discovery).
   *  null when not connected. Drives which config/connect UI the card opens. */
  boundVia: "oauth" | "sa" | null;
  /** The SA-bound resource (GA4 property id / GSC site) when boundVia === "sa",
   *  so the card can prefill it for viewing/editing. Null otherwise. */
  boundResource: string | null;
  /** Human-identifiable connected item (repo full name, GA4 property id, GSC
   *  site, VTEX account) shown in place of the config gear once satisfied. Null
   *  when not yet configured or the binding has nothing to display. */
  connectedDetail: string | null;
}

/** Providers connected through the shared-SA lane, keyed by binding type
 *  (e.g. "google-analytics"), from the commerce-discovery status endpoint. */
export type SaBindings = Record<string, { resource: string | null }>;

/** Binding types a merchant MUST connect before continuing. Currently empty —
 *  no source is mandatory; the continue gate falls back to "any source ready"
 *  (see companion-mcps-section). Add a binding type here to make it required
 *  again. */
export const REQUIRED_BINDING_TYPES: ReadonlySet<string> = new Set([]);

/**
 * Whether a linked binding actually has what it needs to produce data. A
 * binding can be "linked" (its connection id is written into the CD state) yet
 * unusable: VTEX linked with no account/credentials, GitHub linked with no repo
 * picked, GA/GSC linked via OAuth with no property/site chosen. A shared-SA
 * binding is always configured — the verification IS the configuration.
 *
 * `companionConfig` is the linked companion connection's configuration_state;
 * `cdConfig` is the Commerce Discovery connection's configuration_state (where
 * the free-standing `github_repo` lives).
 */
export function isCompanionConfigured(args: {
  bindingType: string;
  boundVia: "oauth" | "sa" | null;
  companionConfig: Record<string, unknown> | null | undefined;
  cdConfig: Record<string, unknown> | null | undefined;
}): boolean {
  if (args.boundVia === "sa") return true;
  const { companionConfig, cdConfig } = args;
  switch (args.bindingType) {
    case "vtex":
      return isMeaningfulConfigValue(companionConfig?.accountName);
    case "shopify":
      // The token is on connection_token — storeDomain is the visible signal.
      return isMeaningfulConfigValue(companionConfig?.storeDomain);
    case "google-analytics":
      return isMeaningfulConfigValue(companionConfig?.propertyId);
    case "google-search-console":
      return isMeaningfulConfigValue(companionConfig?.siteUrl);
    case "github":
      return isMeaningfulConfigValue(cdConfig?.github_repo);
    default:
      // Bindings with no post-link config step are usable as soon as linked.
      return true;
  }
}

/** The human-identifiable connected item for a satisfied binding — repo full
 *  name, GA4 property id, GSC site, VTEX account — shown instead of the config
 *  gear once connected. Mirrors {@link isCompanionConfigured}'s field lookups. */
function getConnectedDetail(args: {
  bindingType: string;
  companionConfig: Record<string, unknown> | null | undefined;
  cdConfig: Record<string, unknown> | null | undefined;
}): string | null {
  const { companionConfig, cdConfig } = args;
  switch (args.bindingType) {
    case "vtex":
      return typeof companionConfig?.accountName === "string"
        ? companionConfig.accountName
        : null;
    case "shopify":
      return typeof companionConfig?.storeDomain === "string"
        ? companionConfig.storeDomain
        : null;
    case "google-analytics":
      return typeof companionConfig?.propertyId === "string"
        ? companionConfig.propertyId
        : null;
    case "google-search-console":
      return typeof companionConfig?.siteUrl === "string"
        ? companionConfig.siteUrl
        : null;
    case "github":
      return typeof cdConfig?.github_repo === "string"
        ? cdConfig.github_repo
        : null;
    default:
      return null;
  }
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

/**
 * Static binding requirements for the four Commerce Discovery companions — a
 * fallback for when the CD connection's live MCP_CONFIGURATION schema can't be
 * fetched (e.g. the CD proxy returns 401 because the connection lost its
 * credential to reach commerce-skills). Without this the schema fetch is a hard
 * dependency: one 401 collapses the whole integrations section to an error and
 * the user can neither connect nor disconnect anything.
 *
 * `fieldKey` is the CD `configuration_state` key and `bindingType` is the
 * binding `__type` (== the curated COMMERCE_COMPANION_MCPS key). Kept in sync
 * with commerce-discovery's CONNECTION_PROVIDERS (vtex/ga4/gsc/github); if the
 * CD schema gains a binding it still appears via the live schema — this
 * fallback only applies when the schema is unreachable.
 */
export const FALLBACK_COMPANION_REQUIREMENTS: BindingRequirement[] = [
  { fieldKey: "vtex", bindingType: "vtex" },
  { fieldKey: "shopify", bindingType: "shopify" },
  { fieldKey: "ga4", bindingType: "google-analytics" },
  { fieldKey: "gsc", bindingType: "google-search-console" },
  { fieldKey: "github", bindingType: "github" },
];

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

function isMeaningfulConfigValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(isMeaningfulConfigValue);
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entryValue]) =>
        !key.startsWith("__") && isMeaningfulConfigValue(entryValue),
    );
  }
  return false;
}

const CONFIG_FIELD_LABEL_KEYS: Record<string, TranslationKey> = {
  accountName: "commerceOnboarding.companionCard.configField.accountName",
  appKey: "commerceOnboarding.companionCard.configField.appKey",
  appToken: "commerceOnboarding.companionCard.configField.appToken",
  propertyId: "commerceOnboarding.companionCard.configField.propertyId",
  siteUrl: "commerceOnboarding.companionCard.configField.siteUrl",
};

function formatConfigurationKey(key: string, t: TFunction): string {
  const labelKey = CONFIG_FIELD_LABEL_KEYS[key];
  if (labelKey) return t(labelKey);

  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringifyConfigurationValue(value: unknown): string | null {
  if (!isMeaningfulConfigValue(value)) return null;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function getConfigurationSummaryEntries(
  state: Record<string, unknown> | null | undefined,
  t: TFunction,
): Array<{ key: string; label: string; value: string }> {
  if (!state) return [];
  return Object.entries(state).flatMap(([key, value]) => {
    if (key.startsWith("__")) return [];
    const stringValue = stringifyConfigurationValue(value);
    if (!stringValue) return [];
    return [{ key, label: formatConfigurationKey(key, t), value: stringValue }];
  });
}

export function shouldAutoOpenCompanionConfig({
  autoOpenFieldKey,
  card,
}: {
  autoOpenFieldKey: string | null;
  card: Pick<
    CompanionCardModel,
    "fieldKey" | "satisfied" | "linkedConnectionId"
  >;
}): boolean {
  return (
    autoOpenFieldKey === card.fieldKey &&
    card.satisfied &&
    !!card.linkedConnectionId
  );
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
      (c.app_name === bindingType ||
        (!!registryAppId && c.app_id === registryAppId)) &&
      // Repo-scoped github children (per-agent import / "Add repo") share the
      // deco/mcp-github identity but can't list installations — linking one
      // breaks the repo picker. Only org-level connections are valid candidates.
      getRepoScope(c) === null,
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
  const meta = getStudioMcpMetadata(item._meta);
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
  connectionReadiness?: Record<string, boolean>;
  configurationState: Record<string, unknown> | null | undefined;
  curated: Record<string, CompanionCopy>;
  /** Providers connected via the shared-SA lane (from commerce-discovery). */
  saBindings?: SaBindings;
}): CompanionCardModel[] {
  const cards: CompanionCardModel[] = [];
  const connectionsById = new Map(args.connections.map((c) => [c.id, c]));
  for (const req of args.requirements) {
    const curatedEntry = args.curated[req.bindingType];
    const item = curatedEntry
      ? args.itemsById[curatedEntry.registryAppId]
      : args.itemsByName[req.bindingType];
    if (!item) continue; // gate: not installable → skip
    const linked = (
      args.configurationState?.[req.fieldKey] as { value?: string } | undefined
    )?.value;
    const linkedConnection = linked ? connectionsById.get(linked) : undefined;
    const linkedConnectionId: string | null =
      linked && linkedConnection ? linked : null;
    const linkedReady = linkedConnectionId
      ? args.connectionReadiness?.[linkedConnectionId] !== false
      : false;
    // OAuth (local configuration_state) takes precedence; else the shared-SA
    // binding reported by commerce-discovery. Mirrors run-time resolution.
    const oauthSatisfied = !!linkedConnectionId && linkedReady;
    const saBinding = oauthSatisfied
      ? undefined
      : args.saBindings?.[req.bindingType];
    const satisfied = oauthSatisfied || !!saBinding;
    const boundVia: "oauth" | "sa" | null = oauthSatisfied
      ? "oauth"
      : saBinding
        ? "sa"
        : null;
    const configured =
      satisfied &&
      isCompanionConfigured({
        bindingType: req.bindingType,
        boundVia,
        companionConfig: linkedConnection?.configuration_state ?? null,
        cdConfig: args.configurationState ?? null,
      });
    cards.push({
      fieldKey: req.fieldKey,
      bindingType: req.bindingType,
      registryItem: item,
      title: cardTitle(item, req.bindingType),
      icon: cardIcon(item),
      headline:
        curatedEntry?.headline ??
        getStudioMcpMetadata(item._meta)?.short_description ??
        null,
      area: curatedEntry?.area ?? null,
      bullets: curatedEntry?.bullets ?? [],
      satisfied,
      configured,
      required: REQUIRED_BINDING_TYPES.has(req.bindingType),
      candidateConnectionId: satisfied
        ? null
        : linkedConnectionId
          ? linkedConnectionId
          : resolveCandidate(
              args.connections,
              req.bindingType,
              curatedEntry?.registryAppId,
            ),
      linkedConnectionId,
      configurationState: linkedConnection?.configuration_state ?? null,
      boundVia,
      boundResource: saBinding?.resource ?? null,
      connectedDetail: satisfied
        ? getConnectedDetail({
            bindingType: req.bindingType,
            companionConfig: linkedConnection?.configuration_state ?? null,
            cdConfig: args.configurationState ?? null,
          })
        : null,
    });
  }
  return cards;
}

export interface PropertyOptionGroup {
  account: string;
  options: Array<{ value: string; label: string }>;
}

/** Normalize both contextSiteUrl and GSC registered sites, then find a match.
 * Handles formats: https://host/, https://www.host/, sc-domain:host, raw domain.
 * Returns the matching site's siteUrl or null.
 */
export function matchGscSite(
  contextSiteUrl: string | undefined,
  sites: Array<{ siteUrl: string }>,
): string | null {
  if (!contextSiteUrl) return null;

  const normalize = (url: string): string => {
    // Strip sc-domain: prefix, then fall through to the same www-stripping
    // as the URL branch below so both formats compare equal.
    const host = url.startsWith("sc-domain:")
      ? url.substring(10)
      : (() => {
          try {
            return new URL(url.startsWith("http") ? url : `https://${url}`)
              .hostname;
          } catch {
            return null;
          }
        })();
    if (host === null) return url;
    return host.startsWith("www.") ? host.substring(4) : host;
  };

  const contextNorm = normalize(contextSiteUrl);
  for (const site of sites) {
    if (normalize(site.siteUrl) === contextNorm) {
      return site.siteUrl;
    }
  }
  return null;
}

/** Flatten GA get-account-summaries response into grouped select options.
 * Groups properties by account display name. */
export function toPropertyOptions(response: unknown): PropertyOptionGroup[] {
  const data = response as
    | {
        response?: {
          accountSummaries?: Array<{
            account: string;
            displayName: string;
            propertySummaries?: Array<{
              property: string;
              displayName: string;
            }>;
          }>;
        };
      }
    | undefined;

  const summaries = data?.response?.accountSummaries ?? [];
  return summaries.map((acc) => ({
    account: acc.account,
    // Property names aren't unique across GA accounts (e.g. an agency managing
    // several client sites, each with a property named after the same domain);
    // the account name disambiguates them once the caller flattens groups into
    // a single picker list (SelectableList has no grouped-header rendering).
    options: (acc.propertySummaries ?? []).map((prop) => ({
      value: prop.property,
      label: `${prop.displayName} (${acc.displayName})`,
    })),
  }));
}
