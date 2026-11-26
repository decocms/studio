/**
 * "Does it matter for the problem?" - the third validation level: how many
 * people the change reaches and whether behavior there differs from the page.
 * Computed from the diagnosis, no model; it says whether a test is worth it.
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
  /** In words, with a number. */
  value: string;
  /** The target's signal ÷ the page's. NULL = no comparison. */
  ratio: number | null;
}

export interface HypothesisRelevance {
  level: RelevanceLevel;
  device: UxDevice;
  /** PDP views per week on the device. */
  views_week: number;
  /** % of those who reach the target today. NULL = the hypothesis covers the whole page. */
  reach_pct: number | null;
  /** % of the views the change reaches. */
  affected_pct: number;
  affected_week: number;
  /** How the calculation was made, in words. */
  basis: string;
  signals: RelevanceSignal[];
  computed_at: string;
}

/** Below this the change reaches too few people for a test. */
const MIN_AFFECTED_WEEK = 500;
const MIN_AFFECTED_PCT = 5;
const LOW_PCT = 20;
const HIGH_PCT = 50;
/** A target signal from 1.2× the page's counts as "different". */
const STRONG_RATIO = 1.2;

const round1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) =>
  v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** % of those who reach `depth`% of the page, from the curve (or the three marks). */
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
 * Where the target is: `{ y }` in px, `{ reach }` in % (section), or null.
 * Overlay sections (pop-up, drawer) have no scroll reach, so when clicks
 * exceed it the floor is clicks ÷ views.
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
  // Hidden on load (in a panel that another click opens): y is not a position.
  return label && !label.hidden ? { y: label.y } : null;
}

function elementSignals(
  alvo: NonNullable<HypothesisTree["alvo"]>,
  b: DevicePdpBehaviour,
  labels: PageCapture["element_labels"] | undefined,
): RelevanceSignal[] {
  // Section: sum its elements (the heatmap has no dead click per section).
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
  // A dead click on a link or form submit is usually a slow page load, so only in-place elements count.
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
        // Measures who CHOSE to click (intent), not the effect of the element.
        value: `${fmt(here * 100)}% de quem escolheu clicar aqui põe no carrinho (página: ${fmt(page * 100)}%)`,
        ratio: round1(here / page),
      });
    }
  }
  return out;
}

/** A hypothesis's relevance, or null without measured behavior on the device. */
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
  // Moving it to the first screen affects everyone; changing it in place only affects those who get there.
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
