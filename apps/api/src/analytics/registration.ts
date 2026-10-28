/**
 * A site's Deco Analytics registration, on the control-plane. The warehouse
 * `site_id` (`config.id`, `s<id>`) only exists there, so the hosting BFF and
 * ANALYTICS_INSTALL both go through here. Callers must already have checked
 * that the org owns `site`: the control-plane answers for any slug.
 */

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
  site: string,
  sub: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response | null> {
  const { controlplaneRestUrl, controlplaneServiceToken } = getSettings();
  if (!controlplaneRestUrl || !controlplaneServiceToken) return null;
  return fetch(
    `${controlplaneRestUrl}/sites/${encodeURIComponent(site)}/${sub}`,
    {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${controlplaneServiceToken}`,
        Accept: "application/json",
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    },
  );
}

export async function readAnalyticsRegistration(
  site: string,
): Promise<AnalyticsRegistration> {
  try {
    const res = await controlplane(site, "analytics/status");
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
  const res = await controlplane(site, "analytics/register", {
    method: "POST",
    body,
  });
  if (!res) throw new Error("Hosting integration is not configured");
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
    } | null;
    const code = typeof payload?.error === "string" ? payload.error : null;
    throw new AnalyticsRegistrationError(
      typeof payload?.message === "string"
        ? payload.message
        : (code ?? `Analytics registration failed (${res.status})`),
      code,
    );
  }
}

/** The hosts a keyed site collects from: its domain with and without `www.`,
 *  since a store answers on both and the collector drops any other origin. */
export function siteDomains(host: string): string[] {
  const apex = host.toLowerCase().replace(/^www\./, "");
  return [apex, `www.${apex}`];
}
