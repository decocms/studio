/**
 * Triagem: o portão em código que a hipótese passa ANTES de gastar
 * verificação (a "relevância" do ARTEMIS). Até 19/11 quem filtrava era a
 * revisão contraditória (um modelo) e, depois, o verificador (navegador +
 * modelo). Aqui ficam as regras que não precisam de modelo nenhum, porque
 * leem os fatos (facts.ts) que a hipótese cita:
 *
 * 1. Tem fato a favor. Sem nenhum fato citado, a hipótese é opinião.
 * 2. A causa não é só número de funil. Taxa e recorte são o sintoma; a causa
 *    é algo da página (posição, conteúdo, elemento, sonda) — salvo nas
 *    categorias em que a causa mora fora dela (tráfego, comercial).
 * 3. Na perda de dispositivo, o que a hipótese cita como diferença tem que
 *    ser diferente de verdade: o mesmo rótulo com o mesmo valor nas duas
 *    telas não é contraste.
 * 4. Não repete outra hipótese da mesma oportunidade (os mesmos fatos a favor).
 * 5. Não contradiz uma sonda: "o elemento não responde" cai se a sonda tocou
 *    nele e a página reagiu (probes.ts).
 */

import type { UxFact } from "./facts.ts";
import type { HypothesisTree } from "./tree.ts";

/** Fatos que descrevem a página (não o funil). */
const PAGE_KINDS = new Set<UxFact["kind"]>([
  "posicao",
  "pagina",
  "secao",
  "elemento",
  "interacao",
  "concorrente",
  "verificacao",
]);

/** Categorias cuja causa pode morar fora da página. */
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
  /** "dispositivo" | "segmento" | "absoluta" — o tipo da perda. */
  control: string | null;
  /**
   * O rótulo do alvo quando é um elemento da Deco Analytics (`button
   * "Next item"`), como a captura achou. NULL = o alvo não é um elemento.
   */
  elementLabel: string | null;
}

/**
 * O motivo de a hipótese cair, ou null se passa. `kept` são os conjuntos de
 * fatos a favor das hipóteses já aceitas na mesma oportunidade.
 */
export function triage(
  h: TriageInput,
  book: Map<string, UxFact>,
  /** As chaves (`triageKey`) das hipóteses já aceitas na mesma oportunidade. */
  kept: string[] = [],
): string | null {
  const favor = h.tree.a_favor.flatMap((c) => c.facts ?? []);
  if (favor.length === 0) {
    return "nenhum fato a favor citado: sem dado, a causa é opinião";
  }
  const cited = [...favor, ...(h.tree.fatos_contraste ?? [])]
    .map((id) => book.get(id))
    .filter((f): f is UxFact => !!f);
  // Sem nenhum fato de página no livro (carrinho/checkout: não há print nem
  // heatmap), a causa só pode se apoiar no funil.
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
  // A mesma parte da página com os mesmos fatos a favor é a mesma causa
  // escrita duas vezes. Sem alvo não dá pra dizer: duas causas diferentes
  // podem citar o mesmo fato.
  if (h.tree.alvo) {
    const key = triageKey(h.tree);
    if (key && kept.includes(key)) {
      return "repete outra hipótese desta oportunidade (mesma categoria, mesmo alvo, mesmos fatos a favor)";
    }
  }
  if (h.elementLabel && NOT_RESPONDING.test(`${h.title} ${h.tree.causa}`)) {
    const probe = reactedProbe(h.elementLabel, book);
    if (probe) {
      return `a sonda tocou no elemento e a página reagiu (${probe.id}: ${probe.text.slice(0, 160)})`;
    }
  }
  return null;
}

/**
 * A sonda que tocou neste elemento e viu a página reagir (o texto dela não diz
 * "nada mudou"). Usada pela regra 5. Exportado pra teste.
 */
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

/** A chave da regra 4: alvo + fatos a favor. NULL = sem alvo. */
export function triageKey(tree: HypothesisTree): string | null {
  if (!tree.alvo) return null;
  const favor = tree.a_favor.flatMap((c) => c.facts ?? []);
  return `${tree.category}|${tree.alvo.kind}:${tree.alvo.key}|${[...new Set(favor)].sort().join(",")}`;
}
