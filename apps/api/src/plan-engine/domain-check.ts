import { type Fetcher, USER_AGENTS } from "./browser.ts";

export type DomainCheck =
  | { ok: true; host: string; blocks_bots: boolean }
  | { ok: false; domain: string; reason: string };

const REQUEST_TIMEOUT_MS = 8000;
const BOT_BLOCK_STATUSES = new Set([401, 403, 429]);

/** "www.loja.example" and "loja.example" are the same store. */
export function sameStore(a: string, b: string): boolean {
  return a.replace(/^www\./, "") === b.replace(/^www\./, "");
}

/** Checks the domain exists and responds, retrying with www; bot-blocking statuses (401/403/429) count as existing. */
export async function checkDomain(
  domain: string,
  fetcher: Fetcher = fetch,
): Promise<DomainCheck> {
  const hosts = domain.startsWith("www.")
    ? [domain]
    : [domain, `www.${domain}`];
  let reason = "não respondeu (DNS ou conexão)";
  for (const host of hosts) {
    try {
      const res = await fetcher(`https://${host}/`, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": USER_AGENTS.desktop },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Only release the connection; failing here does not change the response.
      res.body?.cancel().catch(() => {});
      const finalHost = res.url ? new URL(res.url).host : host;
      if (res.status >= 200 && res.status < 400) {
        return { ok: true, host: finalHost, blocks_bots: false };
      }
      if (BOT_BLOCK_STATUSES.has(res.status)) {
        return { ok: true, host: finalHost, blocks_bots: true };
      }
      reason = `respondeu HTTP ${res.status}`;
    } catch {
      // keep the previous reason: an error response outranks "did not respond"
    }
  }
  return { ok: false, domain, reason };
}
