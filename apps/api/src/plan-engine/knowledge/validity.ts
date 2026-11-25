/**
 * Validade do que a loja aprendeu. Um veredito ("não é o caso nesta loja: o
 * Leve o Look toma a 1ª tela") vale pra página COMO ESTAVA. Até 19/11 ele
 * valia pra sempre: se a loja mudasse a página, o "já desmentido" continuava
 * barrando a hipótese; e não havia como saber se ainda valia.
 *
 * A assinatura é do TEMPLATE, não do produto: as seções da página (Deco
 * Analytics), as partes que a captura achou e se há barra de compra fixa.
 * Isso não muda de um produto pro outro, e muda quando a loja mexe no
 * layout. Posições em px ficam de fora (mudam com o produto), e pop-up também
 * (muda com a campanha).
 */

import { primaryCaptures } from "../probes.ts";
import type { DiagnosisEvidence, UxDevice } from "../types.ts";
import type { KnowledgeEntry } from "./types.ts";

/** FNV-1a de 32 bits: estável e síncrono (o crypto.subtle é assíncrono). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * `<tipo>|<dispositivo>|<hash>`, ou null sem captura nem seção pra assinar.
 * Exportado pra teste.
 */
export function pageSignature(
  evidence: DiagnosisEvidence,
  device: UxDevice,
): string | null {
  const pageType = evidence.page_type ?? "pdp";
  const sections = (
    evidence.pdp_behaviour.find((b) => b.device === device)?.sections ?? []
  )
    .map((s) => s.section)
    .sort();
  const capture = primaryCaptures(evidence).find((c) => c.device === device);
  const parts = capture
    ? Object.entries(capture.positions ?? {})
        .filter(([, y]) => y !== null && y !== undefined)
        .map(([k]) => k)
        .sort()
    : [];
  if (sections.length === 0 && parts.length === 0) return null;
  const body = JSON.stringify({
    sections,
    parts,
    sticky: capture?.has_sticky_buy ?? null,
  });
  return `${pageType}|${device}|${fnv1a(body)}`;
}

/**
 * Marca como vencida (`stale`) a entrada aprendida numa página que mudou: a
 * assinatura dela é do mesmo tipo de página e dispositivo desta análise, e o
 * hash é outro. Sem assinatura, ou de outra página/dispositivo, não mexe.
 */
export function markStale(
  entries: KnowledgeEntry[],
  evidence: DiagnosisEvidence,
): KnowledgeEntry[] {
  const current = new Map<string, string>();
  for (const device of ["mobile", "desktop"] as const) {
    const s = pageSignature(evidence, device);
    if (s) current.set(s.slice(0, s.lastIndexOf("|")), s);
  }
  return entries.map((e) => {
    if (!e.assinatura) return e;
    const now = current.get(
      e.assinatura.slice(0, e.assinatura.lastIndexOf("|")),
    );
    return now && now !== e.assinatura ? { ...e, stale: true } : e;
  });
}
