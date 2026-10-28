/**
 * A site's Deco Analytics registration, on the control-plane. The warehouse
 * `site_id` (`config.id`, `s<id>`) only exists there, so the hosting BFF and
 * ANALYTICS_INSTALL both go through here. Callers must already have checked
 * that the org owns `site`: the control-plane answers for any slug. A site the
 * control-plane doesn't host registers by domain instead
 * (`registerExternalAnalyticsSite`).
 */

import { productionUrlFromDomain } from "@decocms/shared/deco-site-production-url";
import { getSettings } from "../settings";

export type AnalyticsRegistration =
  | {
      status: "registered";
      id: string;
      /** The public `dq_…` key of a keyed site; null for a host-resolved one. */
      key: string | null;
      host: string | null;
      modules: string[];
    }
  /** `host` is the site's production domain, what a registration would use. */
  | { status: "unregistered"; host: string | null }
  /** Unreachable or not configured: never cache this as "unregistered". */
  | { status: "error" };

async function controlplane(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response | null> {
  const { controlplaneRestUrl, controlplaneServiceToken } = getSettings();
  if (!controlplaneRestUrl || !controlplaneServiceToken) return null;
  return fetch(`${controlplaneRestUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${controlplaneServiceToken}`,
      Accept: "application/json",
      ...(init.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const sitePath = (site: string, sub: string) =>
  `/sites/${encodeURIComponent(site)}/${sub}`;

export async function readAnalyticsRegistration(
  site: string,
): Promise<AnalyticsRegistration> {
  try {
    const res = await controlplane(sitePath(site, "analytics/status"));
    if (!res) return { status: "error" };
    if (!res.ok) {
      console.error(
        `[analytics] status resolve HTTP ${res.status} for site="${site}"`,
      );
      return { status: "error" };
    }
    const body = (await res.json().catch(() => null)) as {
      registered?: boolean;
      host?: string | null;
      key?: string | null;
      config?: { id?: string; modules?: string[] } | null;
    } | null;
    // `config.id` is only present once the site is registered.
    if (!body?.registered || !body.config?.id) {
      return { status: "unregistered", host: body?.host ?? null };
    }
    return {
      status: "registered",
      id: body.config.id,
      key: body.key ?? null,
      host: body.host ?? null,
      modules: body.config.modules ?? [],
    };
  } catch (err) {
    console.error(`[analytics] status resolve failed for site="${site}":`, err);
    return { status: "error" };
  }
}

/** The control-plane's refusal: `code` is its machine reason (`on_cdn`, `no_domains`). */
export class AnalyticsRegistrationError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/** Register `site` with the collector by key. On a site already registered by
 *  host, the control-plane mints it a key under the same id instead, unless the
 *  collector answers `/_dq/*` on its domain (`on_cdn`). */
export async function registerAnalyticsSite(
  site: string,
  body: { key: true; domains: string[]; modules: string[] },
): Promise<void> {
  const res = await controlplane(sitePath(site, "analytics/register"), {
    method: "POST",
    body,
  });
  if (!res) throw new Error("Hosting integration is not configured");
  if (!res.ok) throw await registrationError(res);
}

async function registrationError(
  res: Response,
): Promise<AnalyticsRegistrationError> {
  const payload = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
  } | null;
  const code = typeof payload?.error === "string" ? payload.error : null;
  return new AnalyticsRegistrationError(
    typeof payload?.message === "string"
      ? payload.message
      : (code ?? `Analytics registration failed (${res.status})`),
    code,
  );
}

/** Register a site the control-plane doesn't host, by the domains it's live
 *  on. The warehouse id derives from the first domain, so a domain registered
 *  before answers `created: false` and no key: the key is only ever returned
 *  once, to whoever created it. */
export async function registerExternalAnalyticsSite(body: {
  domains: string[];
  modules: string[];
}): Promise<{ id: string; key: string | null; created: boolean }> {
  const res = await controlplane("/analytics/external", {
    method: "POST",
    body,
  });
  if (!res) throw new Error("Hosting integration is not configured");
  if (!res.ok) throw await registrationError(res);
  const payload = (await res.json()) as {
    id?: unknown;
    key?: unknown;
    created?: unknown;
  };
  if (typeof payload.id !== "string") {
    throw new Error("Analytics registration answered without an id");
  }
  return {
    id: payload.id,
    key: typeof payload.key === "string" ? payload.key : null,
    created: payload.created === true,
  };
}

/** The hosts a keyed site collects from: its domain with and without `www.`,
 *  since a store answers on both and the collector drops any other origin. */
export function siteDomains(host: string): string[] {
  const apex = host.toLowerCase().replace(/^www\./, "");
  return [apex, `www.${apex}`];
}

/** The host of a domain someone typed (`loja.com`, `https://www.loja.com/`). */
export function typedHost(domain: string | undefined): string | null {
  const url = productionUrlFromDomain(domain);
  const host = url ? new URL(url).hostname : null;
  return host?.includes(".") ? host : null;
}
