import { COMMERCE_DISCOVERY_MCP_URL } from "@decocms/mesh-sdk";
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

function resolveBaseUrl(options: CommerceDiscoveryAuthOptions): string {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, "");
  const settings = options.settings ?? getSettings();
  return (
    settings.commerceDiscoveryInternalApiUrl ?? DEFAULT_INTERNAL_API_URL
  ).replace(/\/+$/, "");
}

function resolveApiKey(options: CommerceDiscoveryAuthOptions): string {
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
    throw new Error(await responseErrorMessage(response));
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
 * Trigger the Commerce Discovery diagnostic run for a store — called once the
 * user has connected their data sources ("See full report"). This is the run
 * whose private probes resolve creds and whose completion fires the enriched
 * agent loop. Soft-tolerant: a 409 (diagnostic not upgraded yet) is returned as
 * { triggered: false } rather than thrown, so the UI can still open the report.
 */
export async function triggerCommerceDiscoveryRun(
  input: { siteUrl: string; orgId: string },
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
    body: JSON.stringify({ org_id: input.orgId }),
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
 * OAuth and shared-SA binding). Read-only; soft-tolerant: a diagnostic that was
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
