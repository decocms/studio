import { getSettings } from "@/settings";

/**
 * Studio → WhatsApp worker calls. The deployed Cloudflare Worker owns the WABA
 * connection and exposes a `/send` endpoint; Studio calls it to deliver agent
 * replies, org pick-lists, and verification confirmations. (Verification codes
 * flow the other way — the user sends them to the number.)
 */

/** Whether the WhatsApp concierge is configured (all required settings present). */
export function isWhatsappConfigured(): boolean {
  const s = getSettings();
  return Boolean(
    s.whatsappWorkerUrl &&
      s.whatsappWorkerToken &&
      s.whatsappIngestSecret &&
      s.whatsappConciergeNumber,
  );
}

export function getConciergeNumber(): string | undefined {
  return getSettings().whatsappConciergeNumber;
}

/** Send a WhatsApp message via the worker. `phone` is canonical digits (no '+'). */
export async function sendWhatsApp(phone: string, text: string): Promise<void> {
  const s = getSettings();
  if (!s.whatsappWorkerUrl || !s.whatsappWorkerToken) {
    throw new Error("WhatsApp worker is not configured");
  }
  const url = `${s.whatsappWorkerUrl.replace(/\/$/, "")}/send`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.whatsappWorkerToken}`,
    },
    body: JSON.stringify({ phone, text }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`WhatsApp worker send failed: ${res.status} ${detail}`);
  }
}
