/**
 * Hand-curated general conversion knowledge. It changes by PR, not at runtime:
 * the model never writes here. Every number was checked against the source
 * text, and each entry states what the source does NOT prove; sources that
 * could not be checked do not get in.
 */

import { EXISTING_TRECHOS, SITE_ENTRIES } from "./curated-site.ts";
import type { KnowledgeEntry } from "./types.ts";

type Curated = Omit<
  KnowledgeEntry,
  | "origem"
  | "diagnosis_id"
  | "hypothesis_id"
  | "active"
  | "created_at"
  | "updated_at"
  | "resultado"
  | "trecho"
>;

/** A curated entry with the source's literal excerpt (required). */
export type CuratedInput = Curated & { trecho: string };

const CURATED_AT = "2026-11-15T00:00:00Z";
/** The whole-site ones (curated-site.ts). */
const SITE_CURATED_AT = "2026-11-16T00:00:00Z";

const ENTRIES: Curated[] = [
  {
    id: "cur-001",
    conhecimento:
      "Custo extra que aparece tarde (frete, taxa) é o principal motivo de abandono de quem chega a querer comprar.",
    categoria: "comercial",
    fonte: "Baymard Institute, pesquisa anual de abandono de carrinho",
    fonte_url: "https://baymard.com/lists/cart-abandonment-rate",
    tipo_fonte: "estudo",
    contexto: "Compradoras online dos EUA, todos os segmentos",
    areas: ["frete_entrega", "titulo_preco", "carrinho_checkout"],
    evidencia:
      "Tirando quem só estava olhando, 40% abandonaram porque os custos extras eram altos demais; 20% pela entrega lenta.",
    confiabilidade: "media",
    limitacoes:
      "Motivo declarado em questionário, não comportamento medido; público dos EUA; fala do checkout, não de quando o frete aparece na PDP.",
  },
  {
    id: "cur-002",
    conhecimento:
      "Falta de confiança em pôr o cartão no site faz parte das compradoras desistir.",
    categoria: "confianca",
    fonte: "Baymard Institute, pesquisa anual de abandono de carrinho",
    fonte_url: "https://baymard.com/lists/cart-abandonment-rate",
    tipo_fonte: "estudo",
    contexto: "Compradoras online dos EUA, todos os segmentos",
    areas: ["confianca", "carrinho_checkout"],
    evidencia:
      "19% dos abandonos (tirando quem só olhava) foram por não confiar o cartão ao site.",
    confiabilidade: "media",
    limitacoes:
      "Declarado, não medido; pesa menos em marca conhecida com loja física.",
  },
  {
    id: "cur-003",
    conhecimento:
      "A maior parte da atenção fica na primeira tela e na seguinte; o que está mais abaixo é muito menos visto.",
    categoria: "ux",
    fonte: "Nielsen Norman Group, Scrolling and Attention (eye-tracking)",
    fonte_url: "https://www.nngroup.com/articles/scrolling-and-attention/",
    tipo_fonte: "estudo",
    contexto: "Usuárias de sites variados, rastreamento ocular, desktop",
    areas: [
      "pagina_geral",
      "titulo_preco",
      "tamanho",
      "botao_compra",
      "frete_entrega",
    ],
    evidencia:
      "57% do tempo de leitura acima da dobra; 74% nas duas primeiras telas.",
    confiabilidade: "alta",
    limitacoes:
      "Medido em desktop; no celular a primeira tela é menor. Mostra atenção, não conversão.",
  },
  {
    id: "cur-004",
    conhecimento:
      "A dobra ainda decide: a pessoa só rola se a primeira tela mostra que vale continuar.",
    categoria: "ux",
    fonte: "Nielsen Norman Group, The Fold Manifesto",
    fonte_url: "https://www.nngroup.com/articles/page-fold-manifesto/",
    tipo_fonte: "estudo",
    contexto: "Testes de usabilidade e eye-tracking, vários tamanhos de tela",
    areas: ["pagina_geral", "galeria", "titulo_preco"],
    evidencia:
      "A diferença média de atenção entre o que está acima e abaixo da dobra foi de 84%; quando não veem informação de valor, param de rolar.",
    confiabilidade: "alta",
    limitacoes:
      "Não diz o que pôr acima da dobra numa PDP específica; é sobre atenção.",
  },
  {
    id: "cur-005",
    conhecimento:
      "Página mais rápida no celular converte mais, mesmo com ganhos de décimos de segundo.",
    categoria: "performance",
    fonte: "Deloitte para o Google, Milliseconds Make Millions (2020)",
    fonte_url:
      "https://www.thinkwithgoogle.com/_qs/documents/9757/Milliseconds_Make_Millions_report_hQYAbZJ.pdf",
    tipo_fonte: "estudo",
    contexto: "37 marcas na Europa e EUA, dados das próprias marcas, celular",
    areas: ["pagina_geral", "galeria"],
    evidencia:
      "No varejo, 0,1 s a menos de carregamento no celular veio com +8,4% de conversão.",
    confiabilidade: "media",
    limitacoes:
      "Observacional (antes e depois, não A/B); patrocinado pelo Google; o ganho depende de quão lenta a página era.",
  },
  {
    id: "cur-006",
    conhecimento:
      "O maior elemento da primeira tela deve aparecer em até 2,5 s (LCP) pra experiência contar como boa.",
    categoria: "performance",
    fonte: "web.dev (Google), Largest Contentful Paint",
    fonte_url: "https://web.dev/articles/lcp",
    tipo_fonte: "boa_pratica",
    contexto: "Core Web Vitals, todas as páginas",
    areas: ["pagina_geral", "galeria"],
    evidencia: "LCP ≤ 2,5 s no percentil 75 = bom; acima de 4 s = ruim.",
    confiabilidade: "alta",
    limitacoes: "É limiar de experiência, não prova efeito em conversão.",
  },
  {
    id: "cur-007",
    conhecimento:
      "Página que pula enquanto carrega (layout shift) faz tocar no lugar errado.",
    categoria: "performance",
    fonte: "web.dev (Google), Cumulative Layout Shift",
    fonte_url: "https://web.dev/articles/cls",
    tipo_fonte: "boa_pratica",
    contexto: "Core Web Vitals, todas as páginas",
    areas: ["pagina_geral", "botao_compra", "tamanho"],
    evidencia: "CLS ≤ 0,1 = bom; acima de 0,25 = ruim.",
    confiabilidade: "alta",
    limitacoes:
      "Limiar de experiência; o efeito em conversão não é medido ali.",
  },
  {
    id: "cur-008",
    conhecimento:
      "Muitas opções juntas podem travar a escolha (o estudo das geleias).",
    categoria: "ux",
    fonte:
      "Iyengar & Lepper (2000), When Choice is Demotivating, J. of Personality and Social Psychology",
    fonte_url: "https://doi.org/10.1037/0022-3514.79.6.995",
    tipo_fonte: "estudo",
    contexto: "Degustação num supermercado da Califórnia",
    areas: ["recomendacoes", "leve_o_look", "tamanho"],
    evidencia:
      "Com 24 sabores, menos gente comprou do que com 6 (3% x 30% de quem parou).",
    confiabilidade: "baixa",
    limitacoes:
      "Não replicou de forma consistente: a meta-análise de 2010 (cur-009) achou efeito médio perto de zero.",
  },
  {
    id: "cur-009",
    conhecimento:
      "Na média, mais opções não derrubam a escolha; o efeito só aparece em condições específicas.",
    categoria: "ux",
    fonte:
      "Scheibehenne, Greifeneder & Todd (2010), Can There Ever Be Too Many Options?, J. of Consumer Research",
    fonte_url: "https://doi.org/10.1086/651235",
    tipo_fonte: "estudo",
    contexto: "Meta-análise de 50 experimentos",
    areas: ["recomendacoes", "leve_o_look", "tamanho"],
    evidencia:
      "Somando 50 experimentos, o efeito médio de 'escolha demais' ficou perto de zero, com grande variação entre eles.",
    confiabilidade: "alta",
    limitacoes:
      "Não diz quando o efeito aparece numa vitrine de moda; só que não é regra.",
  },
  {
    id: "cur-010",
    conhecimento:
      "Ter algumas avaliações aumenta muito a chance de compra; depois de umas poucas, o ganho de cada nova cai.",
    categoria: "confianca",
    fonte:
      "Spiegel Research Center (Northwestern), How Online Reviews Influence Sales",
    fonte_url:
      "https://spiegel.medill.northwestern.edu/how-online-reviews-influence-sales/",
    tipo_fonte: "estudo",
    contexto: "Dados de varejistas dos EUA",
    areas: ["confianca", "titulo_preco"],
    evidencia:
      "Produto com 5 avaliações teve chance de compra 270% maior que um sem nenhuma.",
    confiabilidade: "media",
    limitacoes:
      "Observacional: produto com avaliação também é o mais vendido. Não mede onde mostrar as avaliações.",
  },
  {
    id: "cur-011",
    conhecimento:
      "Alvo maior e mais perto é tocado mais rápido e com menos erro (lei de Fitts).",
    categoria: "ux",
    fonte: "Nielsen Norman Group, Fitts's Law and Its Applications in UX",
    fonte_url: "https://www.nngroup.com/articles/fitts-law/",
    tipo_fonte: "boa_pratica",
    contexto: "Interfaces em geral",
    areas: ["botao_compra", "tamanho"],
    evidencia:
      "Tempo pra atingir um alvo cresce com a distância e cai com o tamanho do alvo.",
    confiabilidade: "alta",
    limitacoes:
      "Diz que fica mais fácil tocar, não que mais gente decide comprar.",
  },
  {
    id: "cur-012",
    conhecimento:
      "Quase metade usa o celular com uma mão só: o que fica longe do polegar custa mais.",
    categoria: "ux",
    fonte:
      "Steven Hoober, How Do Users Really Hold Mobile Devices? (UXmatters, 2013)",
    fonte_url:
      "https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php",
    tipo_fonte: "estudo",
    contexto: "1.333 observações na rua, 780 tocando a tela",
    areas: ["botao_compra", "tamanho"],
    evidencia: "49% com uma mão, 36% apoiando na outra, 15% com as duas.",
    confiabilidade: "media",
    limitacoes:
      "2013, telas menores que as de hoje; observação, não conversão.",
  },
  {
    id: "cur-013",
    conhecimento:
      "Alvo de toque deve ter pelo menos 44×44 px pra ser fácil de acertar.",
    categoria: "ux",
    fonte: "W3C, WCAG 2.1 — Understanding Target Size (2.5.5)",
    fonte_url: "https://www.w3.org/WAI/WCAG21/Understanding/target-size.html",
    tipo_fonte: "boa_pratica",
    contexto: "Acessibilidade, todas as interfaces de toque",
    areas: ["tamanho", "botao_compra"],
    evidencia: "Critério AAA: alvo de 44 por 44 pixels CSS.",
    confiabilidade: "alta",
    limitacoes: "Norma de acessibilidade; não mede efeito em venda.",
  },
  {
    id: "cur-014",
    conhecimento:
      "Foto que informa sobre o produto é olhada com atenção; imagem decorativa é ignorada.",
    categoria: "ux",
    fonte: "Nielsen Norman Group, Photos as Web Content (eye-tracking)",
    fonte_url: "https://www.nngroup.com/articles/photos-as-web-content/",
    tipo_fonte: "estudo",
    contexto: "Eye-tracking em sites variados, incluindo e-commerce",
    areas: ["galeria"],
    evidencia:
      "Usuárias prestam atenção em imagens com informação relevante à tarefa e ignoram as que só 'enfeitam'; no e-commerce a foto ajuda a diferenciar itens parecidos.",
    confiabilidade: "alta",
    limitacoes: "Mede atenção, não conversão; não diz quantas fotos usar.",
  },
  {
    id: "cur-015",
    conhecimento:
      "Texto corrido é escaneado, não lido: bloco grande de descrição tende a ser pulado.",
    categoria: "ux",
    fonte: "Nielsen Norman Group, F-Shaped Pattern of Reading on the Web",
    fonte_url:
      "https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/",
    tipo_fonte: "estudo",
    contexto: "Eye-tracking, páginas de texto",
    areas: ["descricao"],
    evidencia:
      "Leitura em F: as primeiras linhas e o começo de cada linha recebem a maior parte das fixações.",
    confiabilidade: "alta",
    limitacoes:
      "O padrão some quando o texto é bem formatado (títulos, listas); não diz o que a cliente precisa ler.",
  },
];

const toEntry = (e: CuratedInput, at: string): KnowledgeEntry => ({
  ...e,
  resultado: null,
  origem: "curada",
  diagnosis_id: null,
  hypothesis_id: null,
  active: true,
  created_at: at,
  updated_at: at,
});

export const CURATED_KNOWLEDGE: KnowledgeEntry[] = [
  ...ENTRIES.map((e) =>
    toEntry({ ...e, trecho: EXISTING_TRECHOS[e.id] ?? "" }, CURATED_AT),
  ),
  ...SITE_ENTRIES.map((e) => toEntry(e, SITE_CURATED_AT)),
];
