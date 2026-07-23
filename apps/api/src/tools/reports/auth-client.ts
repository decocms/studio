import { COMMERCE_DISCOVERY_MCP_URL } from "@decocms/shared/sdk";
import { z } from "zod";
import { getSettings } from "../../settings";
import type { Settings } from "../../settings";

const DEFAULT_INTERNAL_API_URL = new URL(COMMERCE_DISCOVERY_MCP_URL).origin;

const UpgradeResponseSchema = z.object({
  token: z.string().min(1),
});

const BindResponseSchema = z.object({
  binding: z
    .object({ resource_id: z.string(), evidence: z.string() })
    .optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
});

type FetchImpl = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CommerceDiscoveryAuthInput {
  siteUrl: string;
  orgId: string;
  orgName?: string;
  /** Claiming user's email — Commerce Discovery sends the run-completion
   *  email (the onboarding "generating" screen's promise) to this address. */
  email?: string;
  /** Deep link back to this workspace's report, used in that email. */
  reportUrl?: string;
}

export type CommerceDiscoveryProvider = "ga4" | "gsc";

export interface CommerceDiscoveryBindInput {
  siteUrl: string;
  orgId: string;
  provider: CommerceDiscoveryProvider;
  /** ga4: bare numeric property id; gsc: site (sc-domain:… / URL-prefix). */
  resourceId: string;
}

/** Verified ⇒ the resource is bound to this store; rejected ⇒ an actionable
 *  pt-BR reason the form shows inline (wrong domain, SA not granted yet, …). */
export type CommerceDiscoveryBindResult =
  | { ok: true; resourceId: string; evidence: string }
  | { ok: false; reason: string; detail: string };

export interface CommerceDiscoveryAuthOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: FetchImpl;
  settings?: Pick<
    Settings,
    "commerceDiscoveryInternalApiUrl" | "commerceDiscoveryInternalApiKey"
  >;
}

export function resolveBaseUrl(options: CommerceDiscoveryAuthOptions): string {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, "");
  const settings = options.settings ?? getSettings();
  return (
    settings.commerceDiscoveryInternalApiUrl ?? DEFAULT_INTERNAL_API_URL
  ).replace(/\/+$/, "");
}

/**
 * Resolve the Commerce Discovery MCP endpoint URL from env settings, so the
 * CD connection's `connection_url` always targets the same instance as the
 * internal API (prod vs. stg). Falls back to the hardcoded constant when no
 * COMMERCE_DISCOVERY_INTERNAL_API_URL override is set.
 */
export function resolveCommerceDiscoveryMcpUrl(
  options: CommerceDiscoveryAuthOptions = {},
): string {
  return `${resolveBaseUrl(options)}/api/v2/mcp`;
}

export function resolveApiKey(options: CommerceDiscoveryAuthOptions): string {
  const apiKey =
    options.apiKey ??
    (options.settings ?? getSettings()).commerceDiscoveryInternalApiKey;

  if (!apiKey) {
    throw new Error(
      "COMMERCE_DISCOVERY_INTERNAL_API_KEY is required to set up Commerce Discovery.",
    );
  }

  return apiKey;
}

function domainFromSiteUrl(siteUrl: string): string {
  return new URL(siteUrl).hostname;
}

/**
 * Structured claim-failure codes returned by Commerce Discovery's
 * `/upgrade` endpoint. `unknown` is our catch-all for any other error string
 * (missing_org_id, invalid_domain, …) or a non-structured/network failure.
 */
export type CommerceDiscoveryClaimCode =
  | "ownership_unverified"
  | "already_claimed_by_other_org"
  | "unknown";

function isClaimCode(value: unknown): value is CommerceDiscoveryClaimCode {
  return (
    value === "ownership_unverified" || value === "already_claimed_by_other_org"
  );
}

/**
 * Context available for interpolating friendly claim-failure messages.
 * `email` is the logged-in user's email (who tried to claim); `domain` is the
 * site being claimed. Both may be absent, so the mapper degrades gracefully.
 */
export interface CommerceDiscoveryClaimContext {
  email?: string;
  domain?: string;
}

/**
 * Map a structured claim-failure code to a user-facing pt-BR message with the
 * RIGHT guidance per failure. Interpolates the email + domain when available.
 *
 * This lives at the studio boundary (not the UI) because only the thrown
 * Error's `.message` string survives the MCP self-tool-call boundary — the
 * structured `code` does not reach the web app (see `parseSelfToolResult` /
 * `getToolErrorMessage` in commerce-onboarding.tsx, which only read
 * `result.content[].text`). Building the friendly string here makes
 * `error.message` already user-ready in the onboarding banner.
 */
export function commerceDiscoveryClaimMessagePtBr(
  code: CommerceDiscoveryClaimCode,
  context: CommerceDiscoveryClaimContext = {},
): string {
  switch (code) {
    case "ownership_unverified": {
      const who = context.email ? `O e-mail ${context.email}` : "Este e-mail";
      const site = context.domain ? ` ${context.domain}` : " este site";
      return `${who} não tem permissão para reivindicar${site}. Use um e-mail do domínio do site ou peça ao suporte para autorizar seu domínio.`;
    }
    case "already_claimed_by_other_org":
      return "Este site já pertence a outra organização. Fale com o suporte para transferir o acesso.";
    case "unknown":
      return "Não foi possível configurar o Commerce Discovery. Tente novamente ou fale com o suporte.";
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

/**
 * A claim (`/upgrade`) failure carrying the structured `code` parsed from the
 * response JSON's `error` field. Its `.message` is already the friendly pt-BR
 * text — the seam chosen because the code cannot cross the MCP tool boundary.
 */
export class CommerceDiscoveryClaimError extends Error {
  readonly code: CommerceDiscoveryClaimCode;

  constructor(
    code: CommerceDiscoveryClaimCode,
    context: CommerceDiscoveryClaimContext = {},
  ) {
    super(commerceDiscoveryClaimMessagePtBr(code, context));
    this.name = "CommerceDiscoveryClaimError";
    this.code = code;
  }
}

/** Parse the `error` code from an `/upgrade` failure response body. */
async function parseClaimErrorCode(
  response: Response,
): Promise<CommerceDiscoveryClaimCode> {
  const text = await response.text().catch(() => "");
  if (!text) return "unknown";
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return isClaimCode(parsed.error) ? parsed.error : "unknown";
  } catch {
    return "unknown";
  }
}

async function responseErrorMessage(response: Response): Promise<string> {
  const fallback = `Commerce Discovery auth failed with status ${response.status}.`;
  const text = await response.text().catch(() => "");
  if (!text) return fallback;

  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : null;
    return error ? `Commerce Discovery auth failed: ${error}.` : fallback;
  } catch {
    return fallback;
  }
}

export async function fetchCommerceDiscoveryAuth(
  input: CommerceDiscoveryAuthInput,
  options: CommerceDiscoveryAuthOptions = {},
) {
  const baseUrl = resolveBaseUrl(options);
  const apiKey = resolveApiKey(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const domain = domainFromSiteUrl(input.siteUrl);
  const url = `${baseUrl}/api/v2/internal/diagnostics/${encodeURIComponent(
    domain,
  )}/upgrade`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      org_id: input.orgId,
      ...(input.orgName ? { name: input.orgName } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.reportUrl ? { report_url: input.reportUrl } : {}),
    }),
  });

  if (!response.ok) {
    // Claim (/upgrade) failures carry a structured `error` code. Because that
    // code cannot cross the MCP self-tool-call boundary (only the message
    // string does), we build the friendly pt-BR message HERE, interpolating
    // the email + domain the client already holds, so the onboarding banner
    // shows correct per-code guidance verbatim.
    const code = await parseClaimErrorCode(response);
    throw new CommerceDiscoveryClaimError(code, {
      email: input.email,
      domain,
    });
  }

  const parsed = UpgradeResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      "Commerce Discovery auth response did not include a token.",
    );
  }

  return { authorizationToken: parsed.data.token };
}

/**
 * Bind a GA4 property / GSC site to a store via the shared service account —
 * the consent-free lane for the unverified-OAuth workaround. The client grants
 * `deco-reader@…` access to the resource and types its id; Commerce Discovery
 * VERIFIES the resource belongs to this domain before persisting (ga4: a web
 * stream's defaultUri points here; gsc: the site id embeds the host). With a
 * shared SA, knowing an id is never enough — the verification is the auth.
 *
 * Soft-tolerant: a verification failure (422) or a resource already bound to
 * another store (409) is returned as { ok: false, reason, detail } — the detail
 * is client-safe pt-BR the UI shows inline. Unexpected statuses still throw.
 */
export async function bindCommerceDiscoveryResource(
  input: CommerceDiscoveryBindInput,
  options: CommerceDiscoveryAuthOptions = {},
): Promise<CommerceDiscoveryBindResult> {
  const baseUrl = resolveBaseUrl(options);
  const apiKey = resolveApiKey(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const domain = domainFromSiteUrl(input.siteUrl);
  const url = `${baseUrl}/api/v2/internal/diagnostics/${encodeURIComponent(
    domain,
  )}/bindings`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      org_id: input.orgId,
      provider: input.provider,
      resource_id: input.resourceId,
    }),
  });

  if (response.status === 409) {
    return {
      ok: false,
      reason: "resource_already_bound",
      detail:
        "Este recurso já está vinculado a outra loja. Se ele é seu, fale com o suporte para revisão manual.",
    };
  }
  if (response.status === 422) {
    const parsed = BindResponseSchema.safeParse(await response.json());
    return {
      ok: false,
      reason: parsed.success
        ? (parsed.data.reason ?? "verification_failed")
        : "verification_failed",
      detail:
        (parsed.success ? parsed.data.detail : undefined) ??
        "Não foi possível verificar o acesso a este recurso.",
    };
  }
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }

  const parsed = BindResponseSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.binding) {
    throw new Error(
      "Commerce Discovery bind response did not include a binding.",
    );
  }
  return {
    ok: true,
    resourceId: parsed.data.binding.resource_id,
    evidence: parsed.data.binding.evidence,
  };
}

/**
 * Trigger the Commerce Discovery report run for a store — called once the
 * user has connected their data sources ("See full report"). This is the run
 * whose private probes resolve creds and whose completion fires the enriched
 * agent loop. Soft-tolerant: a 409 (report not upgraded yet) is returned as
 * { triggered: false } rather than thrown, so the UI can still open the report.
 */
export async function triggerCommerceDiscoveryRun(
  input: { siteUrl: string; orgId: string; githubRepo?: string },
  options: CommerceDiscoveryAuthOptions = {},
): Promise<{ triggered: boolean; reason?: string }> {
  const baseUrl = resolveBaseUrl(options);
  const apiKey = resolveApiKey(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const domain = domainFromSiteUrl(input.siteUrl);
  const url = `${baseUrl}/api/v2/internal/diagnostics/${encodeURIComponent(
    domain,
  )}/run`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    // github_repo (optional) is the repo the client picked in the GitHub
    // companion. Commerce Discovery threads it to the enriched-agent hand-off so
    // repo-audit targets the right repo; absent ⇒ GitHub not connected.
    body: JSON.stringify({
      org_id: input.orgId,
      ...(input.githubRepo ? { github_repo: input.githubRepo } : {}),
    }),
  });

  if (response.status === 409) {
    return { triggered: false, reason: "not_upgraded" };
  }
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return { triggered: true };
}

const ConnectionStatusSchema = z.object({
  providers: z.record(
    z.string(),
    z.object({
      connected: z.boolean(),
      via: z.enum(["oauth", "sa"]).nullable(),
      resource: z.string().nullable(),
    }),
  ),
});

export type CommerceDiscoveryConnectionStatus = z.infer<
  typeof ConnectionStatusSchema
>["providers"];

/**
 * Read per-provider connection status for a store — the single source of truth
 * the studio card renders as "Conectado", unifying both lanes (Studio-vault
 * OAuth and shared-SA binding). Read-only; soft-tolerant: a report that was
 * never upgraded (404/409) reports everything disconnected rather than throwing,
 * so the onboarding UI degrades cleanly before the first upgrade.
 */
export async function fetchCommerceDiscoveryConnectionStatus(
  input: { siteUrl: string; orgId: string },
  options: CommerceDiscoveryAuthOptions = {},
): Promise<CommerceDiscoveryConnectionStatus> {
  const baseUrl = resolveBaseUrl(options);
  const apiKey = resolveApiKey(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const domain = domainFromSiteUrl(input.siteUrl);
  const url = `${baseUrl}/api/v2/internal/diagnostics/${encodeURIComponent(
    domain,
  )}/connections/status?org_id=${encodeURIComponent(input.orgId)}`;

  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (response.status === 404 || response.status === 409) {
    return {};
  }
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  const parsed = ConnectionStatusSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.providers : {};
}
