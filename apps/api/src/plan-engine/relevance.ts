/**
 * "Importa pro problema?" — o terceiro nível de validação.
 *
 * A condição existe (o seletor está abaixo da dobra); agora: quantas pessoas
 * a mudança proposta atinge, e o comportamento ali difere do resto da página?
 * Tudo conta sobre o que o diagnóstico já mediu, sem modelo:
 *
 * - onde está o alvo: a posição medida da parte, o y do elemento do heatmap,
 *   ou o alcance da seção;
 * - quantas chegam lá: a curva de rolagem do Deco Analytics (21 pontos; nas
 *   análises antigas, as três marcas 25/50/75%). Na primeira tela = todas;
 * - quantas a mudança atinge: se ela traz o alvo pra primeira tela, todas que
 *   abrem a PDP; se mexe no lugar, só as que chegam até ele;
 * - sinais do heatmap no elemento: clique, clique morto, e quem clicou
 *   ali vai mais ao carrinho que a média?
 *
 * Isto não prova causa: diz se vale testar. Uma condição real que quase
 * ninguém vê não merece um A/B.
 */

import type { HypothesisTree } from "./tree.ts";
import type {
  DevicePdpBehaviour,
  DiagnosisEvidence,
  PageCapture,
  UxDevice,
  UxHypothesis,
} from "./types.ts";

export type RelevanceLevel = "alta" | "media" | "baixa" | "sem_relevancia";

export interface RelevanceSignal {
  label: string;
  /** Em palavras, com número. */
  value: string;
  /** O sinal do alvo ÷ o da página. NULL = sem comparação. */
  ratio: number | null;
}

export interface HypothesisRelevance {
  level: RelevanceLevel;
  device: UxDevice;
  /** Visualizações da PDP por semana no dispositivo. */
  views_week: number;
  /** % de quem chega ao alvo hoje. NULL = a hipótese é da página inteira. */
  reach_pct: number | null;
  /** % das visualizações que a mudança atinge. */
  affected_pct: number;
  affected_week: number;
  /** Como a conta foi feita, em palavras. */
  basis: string;
  signals: RelevanceSignal[];
  computed_at: string;
}

/** Abaixo disso a mudança atinge gente demais pouca pra um teste. */
export const MIN_AFFECTED_WEEK = 500;
export const MIN_AFFECTED_PCT = 5;
const LOW_PCT = 20;
const HIGH_PCT = 50;
/** Sinal do alvo a partir de 1,2× o da página conta como "diferente". */
const STRONG_RATIO = 1.2;

const round1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) =>
  v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** % de quem chega a `depth`% da página, pela curva (ou pelas três marcas). */
export function reachAtDepth(b: DevicePdpBehaviour, depth: number): number {
  const d = Math.min(100, Math.max(0, depth));
  const points =
    b.scroll_curve && b.scroll_curve.length >= 2
      ? b.scroll_curve.map((p) => [p.depth, p.reach_pct] as const)
      : ([
          [0, 100],
          [25, b.reach.p25],
          [50, b.reach.p50],
          [75, b.reach.p75],
          [100, b.reach.p75 / 2],
        ] as const);
  for (let i = 1; i < points.length; i++) {
    const [d0, r0] = points[i - 1]!;
    const [d1, r1] = points[i]!;
    if (d <= d1) {
      const t = d1 === d0 ? 0 : (d - d0) / (d1 - d0);
      return round1(r0 + (r1 - r0) * t);
    }
  }
  return round1(points[points.length - 1]![1]);
}

function captureFor(
  evidence: DiagnosisEvidence,
  device: UxDevice,
): PageCapture | null {
  const first = evidence.captures[0]?.url;
  return (
    evidence.captures.find((c) => c.device === device && c.url === first) ??
    evidence.captures.find((c) => c.device === device) ??
    null
  );
}

/**
 * Onde está o alvo: `{ y }` em px, `{ reach }` em % (seção), ou null.
 *
 * Seção que fica POR CIMA da página (pop-up, gaveta, barra fixa) não tem
 * alcance de rolagem: o Deco Analytics mede quanto da seção entra na tela ao
 * rolar, e um pop-up em y=0 sai com 1–2%. Em 15/11 (numa loja) o pop-up de
 * newsletter cobria a tela inteira, tinha 176 mil cliques em 530 mil
 * visualizações (CTR 957%) e saiu "sem relevância" com alcance de 1,6%. Quando
 * o clique passa do alcance, o piso é cliques ÷ visualizações.
 */
function targetPosition(
  alvo: NonNullable<HypothesisTree["alvo"]>,
  capture: PageCapture | null,
  behaviour: DevicePdpBehaviour,
):
  | { y: number }
  | { reach: number; overlay?: { floor: number; ctr: number } }
  | null {
  if (alvo.kind === "section") {
    const s = behaviour.sections.find((x) => x.section === alvo.key);
    if (!s) return null;
    const floor =
      behaviour.views > 0
        ? Math.min(100, (s.clicks / behaviour.views) * 100)
        : 0;
    if (s.ctr_pct > 100 || floor > s.reach_pct) {
      return {
        reach: Math.max(s.reach_pct, floor),
        overlay: { floor: round1(floor), ctr: s.ctr_pct },
      };
    }
    return { reach: s.reach_pct };
  }
  if (!capture) return null;
  if (alvo.kind === "part") {
    const y =
      capture.positions[alvo.key as keyof PageCapture["positions"]] ?? null;
    return y == null ? null : { y };
  }
  const label = capture.element_labels?.[alvo.key];
  // Escondido na carga (num painel que outro clique abre): o y não é posição.
  return label && !label.hidden ? { y: label.y } : null;
}

function elementSignals(
  alvo: NonNullable<HypothesisTree["alvo"]>,
  b: DevicePdpBehaviour,
  labels: PageCapture["element_labels"] | undefined,
): RelevanceSignal[] {
  // Seção: soma os elementos dela (o heatmap não dá clique morto por seção).
  const pick =
    alvo.kind === "element"
      ? (b.elements ?? []).filter((x) => `${x.root}|${x.el}` === alvo.key)
      : alvo.kind === "section"
        ? (b.elements ?? []).filter((x) => x.section === alvo.key)
        : [];
  if (pick.length === 0) return [];
  const withFunnel = pick.filter((x) => x.funnel);
  const e = {
    clicks: pick.reduce((a, x) => a + x.clicks, 0),
    dead_interactive: pick.reduce((a, x) => a + x.dead_interactive, 0),
    funnel:
      withFunnel.length > 0
        ? {
            visitors: withFunnel.reduce(
              (a, x) => a + (x.funnel?.visitors ?? 0),
              0,
            ),
            carted: withFunnel.reduce((a, x) => a + (x.funnel?.carted ?? 0), 0),
          }
        : null,
  };
  if (e.clicks <= 0) return [];
  const out: RelevanceSignal[] = [];
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  out.push({
    label: "Clique",
    value: `${fmt(share(e.clicks, b.views) * 100)}% das visualizações clicam aqui`,
    ratio: null,
  });
  // Clique morto em link ou envio de formulário é, em geral, a página nova
  // demorando mais de 1 s: não conta como "sem resposta" (busca de uma loja
  // de moda, 16/11). Só os elementos que mudam a própria página entram.
  const inPlace = pick.filter((x) => !labels?.[`${x.root}|${x.el}`]?.navigates);
  const inPlaceClicks = inPlace.reduce((a, x) => a + x.clicks, 0);
  const pageDead = share(b.dead_clicks, b.clicks);
  const dead = share(
    inPlace.reduce((a, x) => a + x.dead_interactive, 0),
    inPlaceClicks,
  );
  if (pageDead > 0 && inPlaceClicks > 0) {
    out.push({
      label: "Clique morto",
      value: `${fmt(dead * 100)}% dos cliques aqui sem resposta (página: ${fmt(pageDead * 100)}%)`,
      ratio: round1(dead / pageDead),
    });
  }
  if (e.funnel && b.funnel && e.funnel.visitors > 0 && b.funnel.visitors > 0) {
    const here = e.funnel.carted / e.funnel.visitors;
    const page = b.funnel.carted / b.funnel.visitors;
    if (page > 0) {
      out.push({
        label: "Carrinho",
        // Mede quem ESCOLHEU clicar (intenção), não o efeito do elemento.
        value: `${fmt(here * 100)}% de quem escolheu clicar aqui põe no carrinho (página: ${fmt(page * 100)}%)`,
        ratio: round1(here / page),
      });
    }
  }
  return out;
}

/**
 * A relevância de uma hipótese, ou null se não há comportamento medido no
 * dispositivo (sem Deco Analytics não dá pra contar).
 */
export function computeRelevance(
  h: Pick<UxHypothesis, "device" | "tree">,
  evidence: DiagnosisEvidence,
  now: string,
): HypothesisRelevance | null {
  const device: UxDevice = h.device === "desktop" ? "desktop" : "mobile";
  const b = evidence.pdp_behaviour.find((x) => x.device === device);
  if (!b || b.views <= 0) return null;
  const viewsWeek = Math.round((b.views * 7) / (evidence.window_days || 7));
  const tree = h.tree ?? null;
  const capture = captureFor(evidence, device);
  const toFirstScreen = tree?.posicao_depois === "primeira_tela";

  let reach: number | null = null;
  let where = "a hipótese é da página inteira";
  if (tree?.alvo) {
    const pos = targetPosition(tree.alvo, capture, b);
    if (pos && "reach" in pos) {
      reach = round1(pos.reach);
      where = pos.overlay
        ? `${tree.alvo.label} fica por cima da página (CTR ${fmt(pos.overlay.ctr)}%): o alcance de rolagem não vale, e pelo menos ${fmt(pos.overlay.floor)}% das visualizações clicam nela`
        : `${reach}% chegam à ${tree.alvo.label}`;
    } else if (pos && capture) {
      if (pos.y < capture.viewport.height) {
        reach = 100;
        where = `${tree.alvo.label} na primeira tela (y=${pos.y}, tela de ${capture.viewport.height}px)`;
      } else {
        const depth = (pos.y / Math.max(1, capture.page_height)) * 100;
        reach = reachAtDepth(b, depth);
        where = `${tree.alvo.label} em ${fmt(depth)}% da página (y=${pos.y}); ${fmt(reach)}% chegam lá`;
      }
    } else {
      where = `não deu pra achar ${tree.alvo.label} nesta captura: contamos a página inteira`;
    }
  }
  // Trazer pra primeira tela muda a página de todo mundo; mexer no lugar só
  // muda pra quem chega até ali.
  const affected = toFirstScreen || reach === null ? 100 : reach;
  const affectedWeek = Math.round((viewsWeek * affected) / 100);
  const signals = tree?.alvo
    ? elementSignals(tree.alvo, b, capture?.element_labels)
    : [];
  const strong = signals.some(
    (s) => s.ratio !== null && s.ratio >= STRONG_RATIO,
  );

  let level: RelevanceLevel;
  if (affectedWeek < MIN_AFFECTED_WEEK || affected < MIN_AFFECTED_PCT) {
    level = "sem_relevancia";
  } else if (affected < LOW_PCT) {
    level = "baixa";
  } else if (affected >= HIGH_PCT && (toFirstScreen || strong)) {
    level = "alta";
  } else {
    level = "media";
  }

  return {
    level,
    device,
    views_week: viewsWeek,
    reach_pct: reach,
    affected_pct: round1(affected),
    affected_week: affectedWeek,
    basis:
      `${where}. ${toFirstScreen ? "A mudança traz o alvo pra primeira tela: muda a página de quem a abre." : reach === null ? "" : "A mudança é no lugar: só muda pra quem chega até ali."}`.trim(),
    signals,
    computed_at: now,
  };
}
