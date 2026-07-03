import { COMMERCE_DISCOVERY_MCP_URL } from "@decocms/mesh-sdk";
import { z } from "zod";
import { getSettings } from "../../settings";
import type { Settings } from "../../settings";

const DEFAULT_INTERNAL_API_URL = new URL(COMMERCE_DISCOVERY_MCP_URL).origin;

const UpgradeResponseSchema = z.object({
  token: z.string().min(1),
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
