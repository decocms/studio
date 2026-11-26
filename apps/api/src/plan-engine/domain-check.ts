import { guardAgainstPrivateUrl } from "@/mcp-clients/url-security";
import { type Fetcher, USER_AGENTS } from "./browser.ts";

export type DomainCheck =
  | { ok: true; host: string; blocks_bots: boolean }
  | { ok: false; domain: string; reason: string };

const REQUEST_TIMEOUT_MS = 8000;
const BOT_BLOCK_STATUSES = new Set([401, 403, 429]);
const MAX_REDIRECTS = 5;

/** Why a URL may not be fetched from the API pod; null when it may. */
type UrlGuard = (url: string) => Promise<string | null>;

class BlockedUrlError extends Error {}

/**
 * GET that follows redirects itself, vetting every hop with `guard`: a
 * competitor domain is typed by a member, and its DNS or a redirect could
 * point at an internal host. Returns the response and the URL it came from.
 */
async function guardedGet(
  url: string,
  fetcher: Fetcher,
  guard: UrlGuard,
  signal: AbortSignal,
): Promise<{ res: Response; url: string }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const blocked = await guard(current);
    if (blocked) throw new BlockedUrlError(blocked);
    const res = await fetcher(current, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENTS.desktop },
      signal,
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) {
      return { res, url: current };
    }
    res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
    current = new URL(location, current).href;
  }
}

/** "www.loja.example" e "loja.example" são a mesma loja. */
export function sameStore(a: string, b: string): boolean {
  return a.replace(/^www\./, "") === b.replace(/^www\./, "");
}

/**
 * Confere se o domínio existe e responde: o modelo sugere concorrente que não
 * existe, e há loja real que só atende em www. Site que barra robô (401/403/429)
 * existe, só vem marcado com blocks_bots. Endereço de rede interna não é
 * buscado: vale como recusado.
 */
export async function checkDomain(
  domain: string,
  opts: { fetcher?: Fetcher; guard?: UrlGuard } = {},
): Promise<DomainCheck> {
  const { fetcher = fetch, guard = guardAgainstPrivateUrl } = opts;
  const hosts = domain.startsWith("www.")
    ? [domain]
    : [domain, `www.${domain}`];
  let reason = "não respondeu (DNS ou conexão)";
  for (const host of hosts) {
    try {
      const { res, url } = await guardedGet(
        `https://${host}/`,
        fetcher,
        guard,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      // Só libera a conexão: falhar aqui não muda a resposta que já veio.
      res.body?.cancel().catch(() => {});
      // A fetcher that follows redirects itself (the browser's) names where it landed.
      const finalHost = new URL(res.url || url).host;
      if (res.status >= 200 && res.status < 400) {
        return { ok: true, host: finalHost, blocks_bots: false };
      }
      if (BOT_BLOCK_STATUSES.has(res.status)) {
        return { ok: true, host: finalHost, blocks_bots: true };
      }
      reason = `respondeu HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        return { ok: false, domain, reason: "endereço de rede interna" };
      }
      // mantém o motivo anterior: se um host respondeu erro, ele vale mais que "não respondeu"
    }
  }
  return { ok: false, domain, reason };
}
