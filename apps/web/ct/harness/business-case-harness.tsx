/**
 * The business case canvas with synthetic cases: one ready with every number,
 * one still building with the money question open, and one written before the
 * canvas had numbers.
 */

import {
  emptyBusinessCase,
  type BusinessCase,
  type BusinessCaseCard,
} from "@decocms/shared/business-case";
import { BusinessCaseCanvas } from "@/components/plan/business-case/business-case-canvas";

const filled = (extra: Partial<BusinessCaseCard>): BusinessCaseCard => ({
  state: "filled",
  bullets: [],
  sources: [],
  ...extra,
});

const base = emptyBusinessCase({
  title: "Mostrar frete e prazo na página de produto",
  objective: "Levar a conversão de 1,8% para 2,1% até o fim do trimestre",
  request: "Quero mostrar o frete e o prazo direto na página de produto",
  area: "pdp",
  now: new Date("2026-11-19T12:00:00.000Z"),
});

const problem = filled({
  summary: "41% de quem chega ao carrinho desiste na hora de ver o frete",
  bullets: ["No celular o abandono chega a 47%"],
  sources: [{ label: "Funil da loja, 90 dias" }],
  metrics: [
    { label: "Nossa loja", value: 41, unit: "percent" },
    { label: "Média do setor", value: 24, unit: "percent" },
    { label: "Tempo até o frete aparecer", value: 4.1, unit: "seconds" },
  ],
});

const scope = filled({
  summary:
    "Um campo de CEP na PDP que mostra preço e prazo do frete antes do “Comprar”",
});

const competitors = filled({
  summary: "Três lojas do segmento já mostram o frete na PDP",
  sources: [
    { label: "Loja Aurora", url: "https://example.com/aurora" },
    { label: "Casa Brisa", url: "https://example.com/brisa" },
    { label: "Mercado Sol", url: "https://example.com/sol" },
  ],
});

const READY: BusinessCase = {
  ...base,
  status: "ready",
  documentPath: "plans/2026-11-19-frete-na-pdp.md",
  cards: {
    problem,
    scope,
    competitors,
    money: filled({
      summary: "Cerca de R$ 114 mil por mês se o abandono cair 1,5 ponto",
      assumption: "Metade do efeito visto nos concorrentes",
      calc: {
        kind: "money",
        base: 104000,
        baseLabel: "carrinhos por mês",
        deltaPp: 1.5,
        value: 72.9,
        valueLabel: "receita por pedido a mais",
        gapPp: 17,
        monthlyValue: 113724,
        ceilingMonthly: 1288872,
      },
    }),
    effort: filled({
      summary: "Componente de CEP na PDP e a chamada à API de frete",
      metrics: [
        { label: "Front-end", value: 4, unit: "days" },
        { label: "Back-end", value: 3, unit: "days" },
        { label: "QA", value: 2, unit: "days" },
      ],
    }),
    risks: filled({
      summary:
        "A PDP ficar mais lenta. Carregar o frete só quando a pessoa digitar o CEP e vigiar o LCP.",
    }),
    measurement: filled({
      summary: "Abandono na etapa de frete, de olho na conversão da PDP",
    }),
    abTest: filled({
      summary: "Metade das visitas vê o frete na PDP por duas semanas",
      calc: {
        kind: "abTest",
        baseline: 0.59,
        mdePp: 1.77,
        nPerGroup: 12036,
        weeks: 2,
        measurable: true,
      },
    }),
    unknowns: filled({
      summary: "Duas coisas ainda em aberto",
      bullets: [
        "Quanto custa cada consulta na API de frete?",
        "Quantos visitantes no celular já têm CEP salvo?",
      ],
    }),
  },
};

const BUILDING: BusinessCase = {
  ...base,
  status: "building",
  cards: {
    ...base.cards,
    problem,
    scope,
    competitors,
    money: {
      state: "asking",
      question:
        "Qual é a margem média por pedido? Com ela eu fecho o dinheiro em jogo.",
      bullets: [],
      sources: [],
    },
  },
};

const OLD: BusinessCase = {
  ...base,
  status: "ready",
  cards: {
    ...base.cards,
    problem: filled({ summary: problem.summary }),
    scope,
    money: filled({ summary: "Uns R$ 40 mil por mês, pela conta da equipe" }),
    effort: filled({ summary: "Duas semanas de uma pessoa" }),
    measurement: filled({ summary: "Abandono no frete" }),
  },
};

const CASES = { ready: READY, building: BUILDING, old: OLD };

export function BusinessCaseHarness({
  kind,
  width,
}: {
  kind: keyof typeof CASES;
  width: number;
}) {
  return (
    <div style={{ width }} className="bg-background p-8">
      <BusinessCaseCanvas
        value={CASES[kind]}
        onAsk={() => {}}
        onOpenDocument={() => {}}
      />
    </div>
  );
}
