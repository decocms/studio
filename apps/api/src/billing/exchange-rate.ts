/**
 * Live USD→BRL rate for BRL credit top-ups — ported verbatim from the
 * gateway's legacy checkout (being deleted in ai-gateway#15) so pricing
 * semantics don't change mid-migration: AwesomeAPI bid, 10-minute cache,
 * stale-cache-then-constant fallback. The rate is locked at CHECKOUT
 * creation (the USD credit lands in the session metadata), so the webhook
 * credits exactly what the buyer saw.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_RATE = 5.5;

let cached: { rate: number; fetchedAt: number } | null = null;

export async function getUsdToBrl(): Promise<number> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rate;
  }
  try {
    const res = await fetch(
      "https://economia.awesomeapi.com.br/json/last/USD-BRL",
      { signal: AbortSignal.timeout(5_000) },
    );
    const data = (await res.json()) as { USDBRL?: { bid?: string } };
    const bid = parseFloat(data.USDBRL?.bid ?? "");
    if (Number.isNaN(bid) || bid <= 0) throw new Error("Invalid rate");
    cached = { rate: bid, fetchedAt: Date.now() };
    return bid;
  } catch {
    return cached?.rate ?? FALLBACK_RATE;
  }
}

/** Payment-currency cents → USD credit cents (identity for USD). */
export function toUsdCreditCents(
  amountCents: number,
  currency: "usd" | "brl",
  usdToBrlRate: number,
): number {
  if (currency === "brl") return Math.round(amountCents / usdToBrlRate);
  return amountCents;
}
