/**
 * Validity of what the store learned: a verdict holds for the page AS IT WAS.
 * The signature is of the template (sections, captured parts, sticky buy bar),
 * not the product; px positions and pop-ups are left out because they vary.
 */

import { primaryCaptures } from "../probes.ts";
import type { DiagnosisEvidence, UxDevice } from "../types.ts";
import type { KnowledgeEntry } from "./types.ts";

/** 32-bit FNV-1a: stable and synchronous (crypto.subtle is asynchronous). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** `<type>|<device>|<hash>`, or null with no capture or section to sign. */
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

/** Marks as stale an entry learned on a page whose signature has the same type and device but another hash. */
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
