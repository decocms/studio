import { USER_AGENTS } from "./browser.ts";

export type DomainCheck =
  | { ok: true; host: string; blocks_bots: boolean }
  | { ok: false; domain: string; reason: string };

const REQUEST_TIMEOUT_MS = 8000;
const BOT_BLOCK_STATUSES = new Set([401, 403, 429]);

/** "www.loja.example" e "loja.example" são a mesma loja. */
export function sameStore(a: string, b: string): boolean {
  return a.replace(/^www\./, "") === b.replace(/^www\./, "");
}

/**
 * Confere se o domínio existe e responde: o modelo sugere concorrente que não
 * existe, e há loja real que só atende em www. Site que barra robô (401/403/429)
 * existe, só vem marcado com blocks_bots.
 */
export async function checkDomain(
  domain: string,
  fetcher: typeof fetch = fetch,
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
      // Só libera a conexão: falhar aqui não muda a resposta que já veio.
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
      // mantém o motivo anterior: se um host respondeu erro, ele vale mais que "não respondeu"
    }
  }
  return { ok: false, domain, reason };
}
