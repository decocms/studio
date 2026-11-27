/**
 * Triage: model-free rules a hypothesis passes before verification effort is
 * spent. They read the facts (facts.ts) the hypothesis cites: it needs a
 * supporting fact, its cause cannot be only a funnel number, a device
 * difference must really differ, it cannot repeat another hypothesis or a
 * cause an earlier round refuted on the same page (ledger.ts), and it cannot
 * contradict a probe (probes.ts).
 */

import type { UxFact } from "./facts.ts";
import type { HypothesisTree } from "./tree.ts";

/** Facts that describe the page (not the funnel). */
const PAGE_KINDS = new Set<UxFact["kind"]>([
  "posicao",
  "pagina",
  "secao",
  "elemento",
  "interacao",
  "concorrente",
  "verificacao",
]);

/** Categories whose cause may live outside the page. */
const OFF_PAGE = new Set(["trafego", "comercial"]);

const NOT_RESPONDING =
  /não (responde|reage|funciona|abre|mostra)|quebrad|sem resposta|clique morto|cliques mortos/i;

const labelValue = (f: UxFact) => {
  const i = f.text.indexOf(":");
  return i < 0
    ? { label: f.text, value: "" }
    : { label: f.text.slice(0, i), value: f.text.slice(i + 1).trim() };
};

export interface TriageInput {
  title: string;
  tree: HypothesisTree;
  /** "dispositivo" | "segmento" | "absoluta" — the loss type. */
  control: string | null;
  /** The target's label when it is a Deco Analytics element. NULL = not an element. */
  elementLabel: string | null;
}

/** The reason the hypothesis is dropped, or null if it passes. */
export function triage(
  h: TriageInput,
  book: Map<string, UxFact>,
  /** Keys (`triageKey`) of hypotheses already accepted for the same opportunity. */
  kept: string[] = [],
  /** `crossRunKey` → title of a cause an earlier round refuted on this page, which has not changed since. */
  refutedBefore: Map<string, { title: string }> = new Map(),
): string | null {
  const favor = h.tree.a_favor.flatMap((c) => c.facts ?? []);
  if (favor.length === 0) {
    return "nenhum fato a favor citado: sem dado, a causa é opinião";
  }
  const cited = [...favor, ...(h.tree.fatos_contraste ?? [])]
    .map((id) => book.get(id))
    .filter((f): f is UxFact => !!f);
  // Without page facts (cart/checkout) the cause can only rest on the funnel
  const hasPageFacts = [...book.values()].some((f) => PAGE_KINDS.has(f.kind));
  if (
    hasPageFacts &&
    !OFF_PAGE.has(h.tree.category) &&
    !cited.some((f) => PAGE_KINDS.has(f.kind))
  ) {
    return "só cita números do funil, que são o sintoma; nenhum fato da página mostra a causa";
  }
  if (h.control === "dispositivo") {
    const contrast = (h.tree.fatos_contraste ?? [])
      .map((id) => book.get(id))
      .filter((f): f is UxFact => !!f);
    const mob = contrast.filter((f) => f.device === "mobile").map(labelValue);
    const desk = contrast.filter((f) => f.device === "desktop").map(labelValue);
    const pairs = mob.flatMap((m) =>
      desk.filter((d) => d.label === m.label).map((d) => [m, d] as const),
    );
    if (pairs.length > 0 && pairs.every(([m, d]) => m.value === d.value)) {
      return `o que cita como diferença é igual nas duas telas (${pairs[0]![0].label}: ${pairs[0]![0].value})`;
    }
  }
  // Same target and supporting facts is the same cause written twice
  if (h.tree.alvo) {
    const key = triageKey(h.tree);
    if (key && kept.includes(key)) {
      return "repete outra hipótese desta oportunidade (mesma categoria, mesmo alvo, mesmos fatos a favor)";
    }
  }
  const prior = refutedBefore.get(crossRunKey(h.tree) ?? "");
  if (prior) {
    return `uma rodada anterior já desmentiu essa causa nesta página ("${prior.title}"), e a página não mudou desde então`;
  }
  if (h.elementLabel && NOT_RESPONDING.test(`${h.title} ${h.tree.causa}`)) {
    const probe = reactedProbe(h.elementLabel, book);
    if (probe) {
      return `a sonda tocou no elemento e a página reagiu (${probe.id}: ${probe.text.slice(0, 160)})`;
    }
  }
  return null;
}

/** The probe that tapped this element and saw the page react. Exported for tests. */
export function reactedProbe(
  label: string,
  book: Map<string, UxFact>,
): UxFact | null {
  for (const f of book.values()) {
    if (f.kind !== "interacao" || !f.text.startsWith(`tocar em ${label}`)) {
      continue;
    }
    if (!/nada mudou/.test(f.text)) return f;
  }
  return null;
}

/** The rule 4 key: target + supporting facts. NULL = no target. */
export function triageKey(tree: HypothesisTree): string | null {
  if (!tree.alvo) return null;
  const favor = tree.a_favor.flatMap((c) => c.facts ?? []);
  return `${tree.category}|${tree.alvo.kind}:${tree.alvo.key}|${[...new Set(favor)].sort().join(",")}`;
}

/**
 * A cause's identity across rounds of the same page: fact ids are renumbered
 * every round, but the category, the target and the funnel step are not.
 * NULL = no target.
 */
export function crossRunKey(tree: HypothesisTree): string | null {
  if (!tree.alvo) return null;
  return `${tree.category}|${tree.alvo.kind}:${tree.alvo.key}|${tree.metrica.key ?? ""}`;
}
