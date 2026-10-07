/**
 * The site-token denylist and kill switch: one Cloudflare KV namespace that
 * Studio writes through the KV REST API and the telemetry ingest and Deco's
 * analytics collector read. Only a key's presence counts; the value is the
 * ISO time it was written.
 *
 *   revoked:<kid>   a revoked site token
 *   kill:<site>     telemetry and analytics dropped for that site
 */

import { getSettings } from "@/settings";

export interface Denylist {
  /** The key's value (the ISO time it was written), or null when absent. */
  get(key: string): Promise<string | null>;
  put(key: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const denylistKeys = {
  revoked: (kid: string) => `revoked:${kid}`,
  kill: (site: string) => `kill:${site}`,
};

export function createKvRestDenylist(config: {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  fetch?: typeof fetch;
}): Denylist {
  const doFetch = config.fetch ?? fetch;
  const url = (key: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/storage/kv/namespaces/${encodeURIComponent(config.namespaceId)}/values/${encodeURIComponent(key)}`;
  const send = async (method: "PUT" | "DELETE", key: string) => {
    const res = await doFetch(url(key), {
      method,
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        ...(method === "PUT" ? { "content-type": "text/plain" } : {}),
      },
      body: method === "PUT" ? new Date().toISOString() : undefined,
    });
    // Deleting an absent key is already the state we want.
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      throw new Error(`denylist ${method} ${key}: HTTP ${res.status}`);
    }
  };
  return {
    get: async (key) => {
      const res = await doFetch(url(key), {
        headers: { authorization: `Bearer ${config.apiToken}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`denylist GET ${key}: HTTP ${res.status}`);
      return await res.text();
    },
    put: (key) => send("PUT", key),
    delete: (key) => send("DELETE", key),
  };
}

/** The configured denylist, or null when this Studio has none. */
export function denylist(): Denylist | null {
  const s = getSettings();
  return s.cfAccountId && s.cfDenylistKvNamespaceId && s.cfKvApiToken
    ? createKvRestDenylist({
        accountId: s.cfAccountId,
        namespaceId: s.cfDenylistKvNamespaceId,
        apiToken: s.cfKvApiToken,
      })
    : null;
}
