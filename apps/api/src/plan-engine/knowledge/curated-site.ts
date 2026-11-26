/**
 * General conversion knowledge for the whole site, in the format of curated.ts:
 * every number was checked against the source, and `trecho` is the literal quote
 * (in the original language) containing it. Unverifiable sources were left out.
 */

import type { CuratedInput } from "./curated.ts";

export const SITE_ENTRIES: CuratedInput[] = [
  // ── Category: list, card, filters, pagination ──────────────────────────
  {
    id: "cur-016",
    conhecimento:
      "Lista de produtos e filtros ruins fazem a maioria desistir de achar o produto; um ajuste modesto já muda muito.",
    categoria: "ux",
    fonte: "Baymard Institute, pesquisa de Listas de Produto e Filtros",
    fonte_url: "https://baymard.com/research/ecommerce-product-lists",
    tipo_fonte: "estudo",
    contexto:
      "Testes de usabilidade em 19 grandes lojas online de 8 segmentos, participantes de 21 a 56 anos",
    areas: ["filtros_ordenacao", "card_produto", "paginacao"],
    evidencia:
      "Em lojas com lista medíocre, 67% a 90% desistiram de achar o produto pedido; nas com ferramentas só um pouco melhores, 17% a 33%.",
    confiabilidade: "media",
    limitacoes:
      "Teste com tarefa dada, não compra real; não diz qual ajuste fez a diferença; a Baymard vende a própria pesquisa.",
    trecho:
      "sites with mediocre product list usability saw abandonment rates of 67-90%, whereas sites with just a slightly optimized toolset saw only 17-33% abandonments for users trying to find the exact same types of product.",
  },
  {
    id: "cur-017",
    conhecimento:
      "Se o card mostra um atributo (cor, comprimento, tecido), a cliente espera poder filtrar por ele.",
    categoria: "ux",
    fonte: "Baymard Institute, Have Filters for All Displayed List Item Info",
    fonte_url:
      "https://baymard.com/research-articles/have-filters-for-list-item-info",
    tipo_fonte: "estudo",
    contexto:
      "Testes de usabilidade + avaliação das maiores lojas dos EUA e Europa",
    areas: ["filtros_ordenacao", "card_produto"],
    evidencia:
      "Nos testes, quem via o atributo no card queria filtrar por ele; 38% das grandes lojas não têm filtro pra tudo o que mostram na lista.",
    confiabilidade: "media",
    limitacoes:
      "O 38% é contagem de lojas, não efeito em venda; o comportamento vem de teste qualitativo.",
    trecho:
      "we observe in usability testing that many users will then want to filter the product list by some of these attributes. Yet our UX benchmark shows that 38% of e-commerce sites don’t have filters for all displayed product listing info.",
  },
  {
    id: "cur-018",
    conhecimento:
      "Filtro que só deixa marcar uma opção por vez (uma cor, uma faixa de preço) faz a cliente perder produtos que serviriam.",
    categoria: "ux",
    fonte:
      "Baymard Institute, Allow Users to Combine Multiple Filtering Values of the Same Type",
    fonte_url:
      "https://baymard.com/research-articles/allow-applying-of-multiple-filter-values",
    tipo_fonte: "estudo",
    contexto: "Testes de usabilidade em lojas grandes, desktop e celular",
    areas: ["filtros_ordenacao"],
    evidencia:
      "Nos testes era comum aplicar 5 ou 6 filtros (até 10); quando as opções se excluíam, usavam menos o filtro e achavam menos produto. 15% das grandes lojas não deixam marcar várias opções.",
    confiabilidade: "media",
    limitacoes: "Qualitativo, sem medida de venda; o 15% é contagem de lojas.",
    trecho:
      "during testing it was not uncommon for test participants to apply 5 or 6 filters, with some applying up to 10",
  },
  {
    id: "cur-019",
    conhecimento:
      "No celular, carregar uma lista curta (15 a 30 produtos) de uma vez funciona melhor; no desktop, produto visual aguenta 100 a 150.",
    categoria: "ux",
    fonte: "Baymard Institute, Product List UX: Number of Products to Load",
    fonte_url: "https://baymard.com/blog/number-of-items-loaded-by-default",
    tipo_fonte: "estudo",
    contexto:
      "Testes de usabilidade + avaliação de lojas grandes, desktop e celular",
    areas: ["paginacao", "card_produto"],
    evidencia:
      "Recomendação dos testes: 15–30 produtos no celular; 100–150 no desktop pra produto visual. 52% das lojas no desktop erram a quantidade.",
    confiabilidade: "media",
    limitacoes:
      "Faixa tirada de teste qualitativo, não de A/B; não considera o peso das imagens nem a velocidade da página.",
    trecho:
      "In summary, due to the physical constraints imposed by the smaller viewport and the way users scroll on mobile, it’s recommended to load only 15–30 products on mobile devices and to load them all at once.",
  },
  {
    id: "cur-020",
    conhecimento:
      "Ao voltar do produto pra lista, a cliente deve cair no ponto onde estava, não no topo.",
    categoria: "ux",
    fonte:
      "Baymard Institute, Return Users to the Same Place in the Product List",
    fonte_url: "https://baymard.com/blog/return-same-place",
    tipo_fonte: "estudo",
    contexto:
      "Testes de usabilidade + avaliação das maiores lojas, desktop e celular",
    areas: ["paginacao"],
    evidencia:
      "Ter que reencontrar o lugar na lista foi causa direta de abandono nos testes; 13% das grandes lojas ainda mandam de volta pro topo.",
    confiabilidade: "media",
    limitacoes:
      "Qualitativo, não quantifica o abandono; o 13% é contagem de lojas.",
    trecho:
      "However, on 13% of sites in our desktop and mobile benchmarks (amongst the world’s largest sites) users are returned to the top of the product list rather than to the place they were at before clicking into the product page.",
  },
  {
    id: "cur-021",
    conhecimento:
      "O card precisa mostrar o essencial pra decidir o clique; sem isso a cliente descarta produto bom.",
    categoria: "ux",
    fonte: "Baymard Institute, What Information to Display in Product Listings",
    fonte_url:
      "https://baymard.com/research-articles/product-listing-information",
    tipo_fonte: "estudo",
    contexto:
      "Testes de usabilidade em larga escala + avaliação de lojas grandes",
    areas: ["card_produto"],
    evidencia:
      "Os testes acharam 5 atributos tão essenciais que a pessoa evita clicar em produto sem eles; 50% das grandes lojas mostram informação insuficiente no card.",
    confiabilidade: "media",
    limitacoes:
      "Os atributos certos mudam por segmento (o artigo não fixa quais pra moda); qualitativo; 50% é contagem de lojas.",
    trecho:
      "Our large-scale testing revealed that there are 5 product attributes that are so essential to users scanning list items that they will actively avoid clicking on products without them",
  },
  {
    id: "cur-022",
    conhecimento:
      "Banner grande no topo da categoria que empurra as subcategorias pra baixo da dobra é o erro mais danoso dessa página.",
    categoria: "ux",
    fonte: "Baymard Institute, Ecommerce Category Pages",
    fonte_url: "https://baymard.com/blog/ecommerce-category-page",
    tipo_fonte: "estudo",
    contexto: "Testes de usabilidade + avaliação de lojas grandes",
    areas: ["topo_categoria"],
    evidencia:
      "76% das lojas não põem as subcategorias como conteúdo principal da categoria intermediária; com banner na primeira tela, boa parte das pessoas nunca chega à navegação.",
    confiabilidade: "media",
    limitacoes:
      "Vale pra categoria intermediária (que leva a subcategorias), não pra lista final de produtos; 'boa parte' não é quantificada; 76% é contagem de lojas.",
    trecho:
      "The fundamental job of a category page is to get users to the right subcategory quickly, yet 76% of sites don’t feature subcategories as the primary content on intermediary category pages.",
  },
  {
    id: "cur-023",
    conhecimento:
      "Ganho de velocidade pesa mais da lista pro produto e pro carrinho do que da home pra lista.",
    categoria: "performance",
    fonte: "Deloitte para o Google, Milliseconds Make Millions (2020)",
    fonte_url:
      "https://www.thinkwithgoogle.com/_qs/documents/9757/Milliseconds_Make_Millions_report_hQYAbZJ.pdf",
    tipo_fonte: "estudo",
    contexto:
      "37 marcas na Europa e EUA (15 de varejo), dados das próprias marcas, celular",
    areas: ["card_produto", "paginacao", "home_destaque"],
    evidencia:
      "Com 0,1 s a menos, a passagem da lista pro produto subiu 3,2% e pro carrinho 9,1%; da home pra lista o efeito foi negativo (mais clique em banner de promoção).",
    confiabilidade: "media",
    limitacoes:
      "Observacional e patrocinado pelo Google; a explicação do efeito negativo na home é dos autores, não medida; mesma base do cur-005.",
    trecho:
      "Speed on product pages is vital. An increase of 3.2% was observed from product listing page to product detail page, and a 9.1% increase when progressing to add to basket.",
  },
  {
    id: "cur-024",
    conhecimento:
      "Pré-carregar a página do produto quando a cliente aponta pro card (ou nos primeiros cards, no celular) faz o produto abrir na hora.",
    categoria: "performance",
    fonte: "web.dev (Google), caso Ray-Ban: prerender com Speculation Rules",
    fonte_url: "https://web.dev/case-studies/rayban-speculation-rules",
    tipo_fonte: "ab_outra_loja",
    contexto:
      "Ray-Ban, lista → página de produto, celular e desktop, só navegadores com suporte à API (Chrome)",
    areas: ["card_produto", "paginacao"],
    evidencia:
      "LCP da página de produto caiu 43%; a conversão nas PDPs subiu 101% no celular e 156% no desktop, o que a marca diz ter confirmado em A/B.",
    confiabilidade: "baixa",
    limitacoes:
      "Não publica amostra, duração nem divisão do A/B; ganho grande demais pra generalizar; só vale em Chrome/Edge; caso divulgado pelo Google, que promove a API.",
    trecho:
      "From a business perspective, the improvements have been transformative, as confirmed by A/B testing: Increased conversion rates: Mobile conversion rates on PDPs substantially increased by 101.47%.",
  },
  {
    id: "cur-025",
    conhecimento:
      "Pôr filtro por tipo e estampa nas páginas de categoria aumentou as vendas numa loja que não tinha filtro.",
    categoria: "ux",
    fonte: "VWO (Wingify), caso Buyakilt.com",
    fonte_url:
      "https://wingify.com/blog/product-filter-ecommerce-ab-testing-revenue/",
    tipo_fonte: "ab_outra_loja",
    contexto:
      "Loja de kilts (Buyakilt.com), páginas de categoria, A/B sem filtro x com filtro na lateral e no meio",
    areas: ["filtros_ordenacao"],
    evidencia:
      "A versão com filtro teve +26% de conversões e +76,1% de receita frente à página sem filtro.",
    confiabilidade: "baixa",
    limitacoes:
      "Sem amostra, duração nem significância publicadas; caso de marketing do fornecedor da ferramenta; a loja partia de nenhum filtro, não serve pra quem já tem.",
    trecho:
      "Overall, there was 76.1% increase in the revenue, 26% increase in conversions, and 19.76% increase in shopping cart visits.",
  },
  {
    id: "cur-026",
    conhecimento:
      "Em categoria pequena e de uma marca só, tirar o menu de filtros aumentou o engajamento com os produtos.",
    categoria: "ux",
    fonte: "VWO (Wingify), caso UKToolCentre",
    fonte_url:
      "https://wingify.com/blog/remove-product-filter-increase-site-engagement",
    tipo_fonte: "ab_outra_loja",
    contexto:
      "UKToolCentre, categoria da marca Cuprinol (produtos pra madeira), A/B com x sem menu de filtros",
    areas: ["filtros_ordenacao"],
    evidencia: "Sem o menu de filtros, o engajamento na página subiu 27%.",
    confiabilidade: "baixa",
    limitacoes:
      "Mede engajamento (cliques), não venda; sem amostra nem duração; categoria pequena de uma marca só. Contraponto ao cur-025: filtro ajuda ou atrapalha conforme o tamanho da lista.",
    trecho:
      "A surprising increase of 27% in engagement on the product page. What happened was that visitors were less distracted by the filter and the easy option of leaving the page that it provided.",
  },
  {
    id: "cur-027",
    conhecimento:
      "Nota perfeita (5,0) não é a que mais vende: a chance de compra é maior entre 4,0 e 4,7.",
    categoria: "confianca",
    fonte:
      "Spiegel Research Center (Northwestern), How Online Reviews Influence Sales",
    fonte_url:
      "https://spiegel.medill.northwestern.edu/how-online-reviews-influence-sales/",
    tipo_fonte: "estudo",
    contexto: "Dados de varejistas dos EUA, várias categorias",
    areas: ["card_produto", "confianca"],
    evidencia:
      "A chance de compra costuma atingir o pico em notas de 4,0 a 4,7 e cai quando a nota se aproxima de 5,0.",
    confiabilidade: "media",
    limitacoes:
      "Observacional; não diz o que fazer com produto nota 5 nem onde mostrar a nota (card ou PDP).",
    trecho:
      "Across product categories, we found that purchase likelihood typically peaks at ratings in the 4.0 – 4.7 range, and then begins to decrease as ratings approach 5.0.",
  },
  {
    id: "cur-028",
    conhecimento: "Avaliação pesa mais em produto caro do que em barato.",
    categoria: "confianca",
    fonte:
      "Spiegel Research Center (Northwestern), How Online Reviews Influence Sales",
    fonte_url:
      "https://spiegel.medill.northwestern.edu/how-online-reviews-influence-sales/",
    tipo_fonte: "estudo",
    contexto: "Dados de varejistas dos EUA",
    areas: ["confianca", "titulo_preco", "card_produto"],
    evidencia:
      "Mostrar avaliações veio com +190% de conversão em produto barato e +380% em produto caro.",
    confiabilidade: "media",
    limitacoes:
      "Observacional (produto com avaliação já tende a vender mais, como no cur-010); não define o que é 'caro'.",
    trecho:
      "Our research found that when reviews were displayed for a lower-priced product, the conversion rate increased 190%. However, for a higher-priced product, the conversion rate increased 380%.",
  },
  {
    id: "cur-029",
    conhecimento:
      "A posição na lista muda o que a pessoa abre, mas não a decisão de comprar depois de abrir.",
    categoria: "ux",
    fonte: "Ursu (2018), The Power of Rankings, Marketing Science 37(4)",
    fonte_url: "https://ideas.repec.org/a/inm/ormksc/v37y2018i4p530-552.html",
    tipo_fonte: "estudo",
    contexto: "Experimento de campo na Expedia com a ordem dos hotéis sorteada",
    areas: ["filtros_ordenacao", "resultados_busca", "card_produto"],
    evidencia:
      "Com a ordem sorteada, a posição afetou o que foi aberto, mas, dado o clique, não afetou a compra; efeito médio de posição de US$ 1,92.",
    confiabilidade: "alta",
    limitacoes:
      "Hotéis, não moda; diz que o topo importa pra ser visto, não que um produto vende mais só por estar no topo.",
    trecho:
      "First, I identify the causal effect of rankings and show that they affect what consumers search, but conditional on search, do not affect purchases. Second, I quantify the effect of rankings using a sequential search model and find an average position effect of $1.92",
  },

  // ── Search ──────────────────────────────────────────────────────────────
  {
    id: "cur-030",
    conhecimento:
      "Autocompletar com sugestões demais vira ruído: até 10 no desktop e 4 a 8 no celular.",
    categoria: "ux",
    fonte:
      "Baymard Institute, 9 UX Best Practices for Autocomplete Suggestions",
    fonte_url: "https://baymard.com/blog/autocomplete-design",
    tipo_fonte: "estudo",
    contexto:
      "Testes de usabilidade + avaliação de lojas grandes, desktop e celular",
    areas: ["campo_busca"],
    evidencia:
      "Acima de ~10 sugestões no desktop (~8 no celular), as pessoas ignoram ou travam lendo; só 19% das lojas acertam todos os detalhes do autocompletar.",
    confiabilidade: "media",
    limitacoes:
      "O artigo não diz quantas pessoas testaram; não mede efeito em venda.",
    trecho:
      "Therefore, the number of autocomplete suggestions displayed to desktop users shouldn’t exceed 10, while a target of 4–8 will work for most mobile users.",
  },
  {
    id: "cur-031",
    conhecimento:
      "Busca que não tolera erro de digitação faz a cliente perder tempo ou desistir.",
    categoria: "ux",
    fonte:
      "Baymard Institute, Offer Autocomplete Suggestions for Misspelled Queries",
    fonte_url:
      "https://baymard.com/blog/offer-autocomplete-suggestions-for-misspellings",
    tipo_fonte: "estudo",
    contexto: "Testes de usabilidade + avaliação de lojas grandes",
    areas: ["campo_busca", "busca_sem_resultado"],
    evidencia:
      "Parte dos participantes gastou 30 s ou mais corrigindo o termo; 69% das lojas não sugerem nada pra termo levemente errado.",
    confiabilidade: "media",
    limitacoes:
      "69% é contagem de lojas; os 30 s são observação qualitativa, sem proporção de pessoas.",
    trecho:
      "Despite the seriousness of the issue, our benchmark shows that 69% of sites don’t support autocomplete spelling suggestions for slightly misspelled queries.",
  },
  {
    id: "cur-032",
    conhecimento:
      "Busca sem resultado precisa oferecer saída (termo parecido, categoria, produto), não só 'nada encontrado'.",
    categoria: "ux",
    fonte: "Baymard Institute, 5 Proven UX Strategies for “No Results” Pages",
    fonte_url: "https://baymard.com/blog/no-results-page",
    tipo_fonte: "estudo",
    contexto: "Testes de usabilidade + avaliação de lojas grandes",
    areas: ["busca_sem_resultado"],
    evidencia:
      "Cerca de 50% das lojas fazem a página sem resultado de um jeito que frustra e aumenta o abandono; nos testes, dica de busca quase nunca era lida.",
    confiabilidade: "media",
    limitacoes: "50% é contagem de lojas; não quantifica o abandono.",
    trecho:
      "Yet our benchmarking finds that about 50% of ecommerce sites implement “No Results” pages in ways that create user frustrations and ultimately increase site abandonments.",
  },
  {
    id: "cur-033",
    conhecimento:
      "Quem busca o nome de uma categoria ('vestido longo') deve cair na categoria, com os filtros dela.",
    categoria: "ux",
    fonte:
      "Baymard Institute, Autodirect or Guide Users to Matching Category Scopes",
    fonte_url:
      "https://baymard.com/blog/autodirect-searches-matching-category-scopes",
    tipo_fonte: "estudo",
    contexto: "Testes de usabilidade + avaliação de lojas grandes",
    areas: ["resultados_busca", "campo_busca"],
    evidencia:
      "46% das lojas não levam a busca pra categoria correspondente; nos testes, busca que devolvia menos que a categoria levou a abandono.",
    confiabilidade: "media",
    limitacoes:
      "46% é contagem de lojas; abandono observado em teste qualitativo, sem taxa.",
    trecho:
      "Search UX: Autodirect or Guide Users to Matching Category Scopes (46% Get It Wrong)",
  },
  {
    id: "cur-034",
    conhecimento: "Se a primeira busca falha, muita gente desiste na hora.",
    categoria: "ux",
    fonte: "Nielsen Norman Group, Search: Visible and Simple (2001)",
    fonte_url: "https://www.nngroup.com/articles/search-visible-and-simple/",
    tipo_fonte: "estudo",
    contexto: "Estudo de busca do NN/g, sites em geral, desktop",
    areas: ["busca_sem_resultado", "resultados_busca"],
    evidencia:
      "Quase metade de quem teve a primeira busca falha desistiu imediatamente.",
    confiabilidade: "media",
    limitacoes:
      "Estudo de 2001, sites em geral, não lojas; buscas melhoraram muito desde então.",
    trecho:
      "Many users don't even bother: In our study, almost half the users whose first search failed gave up immediately.",
  },
  {
    id: "cur-035",
    conhecimento:
      "Campo de busca aberto na tela é bem mais usado do que um link ou ícone 'Buscar'.",
    categoria: "ux",
    fonte: "Nielsen Norman Group, Search: Visible and Simple (2001)",
    fonte_url: "https://www.nngroup.com/articles/search-visible-and-simple/",
    tipo_fonte: "boa_pratica",
    contexto: "Antes/depois na home do useit.com (site de conteúdo)",
    areas: ["menu_busca", "campo_busca"],
    evidencia:
      "Trocar o link por uma caixa de busca na home aumentou o uso da busca em 91%.",
    confiabilidade: "baixa",
    limitacoes:
      "Um site só, de conteúdo, em 2001; mede uso da busca, não venda; no celular falta espaço pra caixa aberta.",
    trecho:
      "When I changed the useit.com homepage to include a search box instead of a link, search engine use increased by 91%.",
  },

  // ── Home and navigation ─────────────────────────────────────────────────
  {
    id: "cur-036",
    conhecimento:
      "Carrossel na home costuma ser mal feito; o pior é girar sozinho e trocar o slide na hora do toque.",
    categoria: "ux",
    fonte: "Baymard Institute, Homepage UX Best Practices",
    fonte_url: "https://baymard.com/blog/ecommerce-homepage-ux",
    tipo_fonte: "estudo",
    contexto: "Testes de usabilidade + avaliação de lojas grandes",
    areas: ["home_destaque"],
    evidencia:
      "36% das lojas usam carrossel na home e quase 75% delas o fazem errado; nos testes, o slide trocava milissegundos antes do clique e abria a página errada.",
    confiabilidade: "media",
    limitacoes:
      "Contagem de lojas + observação qualitativa; não mede venda; a Baymard também diz que as pessoas gostam das imagens grandes do carrossel.",
    trecho:
      "While only 36% of sites use a carousel on the homepage, nearly 75% of those sites implement it incorrectly.",
  },
  {
    id: "cur-037",
    conhecimento:
      "Quase ninguém clica no carrossel da home, e quem clica escolhe o primeiro slide.",
    categoria: "ux",
    fonte:
      "Erik Runyon, Carousel Interaction Stats (Univ. de Notre Dame, 2013)",
    fonte_url: "https://erikrunyon.com/2013/01/carousel-interaction-stats/",
    tipo_fonte: "estudo",
    contexto:
      "Home de nd.edu, carrossel sem giro automático, dados de analytics",
    areas: ["home_destaque"],
    evidencia:
      "Cerca de 1% das visitas clicou num destaque; 84% desses cliques foram no primeiro slide (~4% em cada um dos outros).",
    confiabilidade: "baixa",
    limitacoes:
      "Site de universidade, não loja; um site só, 2013; no carrossel com giro automático do mesmo levantamento, 8,8% das visitas clicaram.",
    trecho:
      "Approximately 1% of visitors click on a feature. There was a total of 28,928 clicks on features for this time period. The feature was manually “switched/rotated” a total of 315,665 times. Of these clicks, 84% were on stories in position 1",
  },
  {
    id: "cur-038",
    conhecimento:
      "Menu escondido (hambúrguer) é bem menos usado que navegação visível, no desktop e no celular.",
    categoria: "ux",
    fonte: "Nielsen Norman Group, Hamburger Menus and Hidden Navigation",
    fonte_url: "https://www.nngroup.com/articles/hamburger-menus/",
    tipo_fonte: "estudo",
    contexto:
      "179 participantes, 6 sites, desktop e celular (NN/g com WhatUsersDo)",
    areas: ["menu_busca"],
    evidencia:
      "Desktop: menu escondido usado em 27% dos casos x 48–50% com navegação visível. Celular: 57% escondido x 86% com parte visível + menu.",
    confiabilidade: "alta",
    limitacoes:
      "Mede uso da navegação, não venda; sites não eram só lojas; não diz quais itens deixar visíveis.",
    trecho:
      "On desktop, people used the hidden menus in only 27% of the cases, while they used visible or combo navigation almost twice as much: in 48% and 50% of the cases, respectively. On mobile people used the hidden navigation in 57% of the cases, and the combo navigation in 86% of the cases",
  },
  {
    id: "cur-039",
    conhecimento:
      "No desktop, o olhar se concentra na metade esquerda da tela.",
    categoria: "ux",
    fonte: "Nielsen Norman Group, Horizontal Attention Leans Left (2017)",
    fonte_url:
      "https://www.nngroup.com/articles/horizontal-attention-leans-left/",
    tipo_fonte: "estudo",
    contexto:
      "Eye-tracking com mais de 120 participantes, monitor 1920×1080, sites em geral (incluindo lojas)",
    areas: ["pagina_geral", "filtros_ordenacao"],
    evidencia:
      "80% das fixações caíram na metade esquerda da página e 20% na direita.",
    confiabilidade: "alta",
    limitacoes:
      "Desktop em tela larga; no celular a coluna é uma só; mede olhar, não venda.",
    trecho:
      "if we were to slice a maximized page down the middle, 80% of the fixations fell on the left half of the screen (even more than our previous finding of 69%). The remaining 20% of fixations were on the right half of the screen.",
  },
  {
    id: "cur-040",
    conhecimento:
      "No celular, quem chega na home rola a página inteira pra entender o que a loja vende.",
    categoria: "ux",
    fonte:
      "Baymard Institute, The State of Mobile E-Commerce Search and Category Navigation (2015)",
    fonte_url:
      "https://baymard.com/blog/mobile-ecommerce-search-and-navigation",
    tipo_fonte: "estudo",
    contexto: "Testes em celular + avaliação de 50 grandes lojas dos EUA, 2015",
    areas: ["home_vitrines", "home_destaque"],
    evidencia:
      "70% dos participantes rolaram a home inteira ao chegar, 'pra ter uma visão das opções'; 42% das lojas não deixam claro na home que tipo de loja são.",
    confiabilidade: "media",
    limitacoes:
      "2015, lojas dos EUA, qualitativo; diz que a home precisa mostrar a variedade, não que rolar é bom ou ruim.",
    trecho:
      "When testing mobile e-commerce site 70% of the test subjects consistently scrolled up and down the entire page when first landing on a homepage, in order to “get an overview of my options.”",
  },

  // ── Cart and checkout ───────────────────────────────────────────────────
  {
    id: "cur-041",
    conhecimento:
      "Checkout com campos demais cansa; dá pra cortar perto de 40% deles.",
    categoria: "ux",
    fonte: "Baymard Institute, Ecommerce Checkout UX Guide",
    fonte_url: "https://baymard.com/blog/checkout-flow-ux-optimization",
    tipo_fonte: "estudo",
    contexto: "Avaliação de checkouts de lojas grandes dos EUA e Europa",
    areas: ["checkout"],
    evidencia:
      "O checkout médio tem 19,9 elementos de formulário; um fluxo otimizado pode ter 12.",
    confiabilidade: "media",
    limitacoes:
      "Contagem de lojas; não mede quanto a conversão sobe ao cortar campos.",
    trecho:
      "Baymard’s checkout benchmark shows the average checkout has 19.9 form elements, while an optimized flow can be as short as 12.",
  },
  {
    id: "cur-042",
    conhecimento:
      "Obrigar a criar conta faz desistir; comprar sem cadastro deve ser a opção mais visível.",
    categoria: "ux",
    fonte: "Baymard Institute, Ecommerce Checkout UX Guide",
    fonte_url: "https://baymard.com/blog/checkout-flow-ux-optimization",
    tipo_fonte: "estudo",
    contexto: "Pesquisa com adultos dos EUA + avaliação de lojas grandes",
    areas: ["checkout"],
    evidencia:
      "18% abandonaram um pedido nos 3 meses anteriores por terem que criar conta; 62% das lojas não deixam a compra sem cadastro como opção principal.",
    confiabilidade: "media",
    limitacoes:
      "Motivo declarado em questionário; não mede o efeito de destacar a compra sem cadastro; com login social ou cadastro rápido pode pesar menos.",
    trecho:
      "18% of surveyed US adults reported abandoning an order in the previous three months because they were forced to create an account.",
  },
  {
    id: "cur-043",
    conhecimento:
      "Avisar o erro do campo na hora (ao sair dele), e não só no fim, evita retrabalho no checkout.",
    categoria: "ux",
    fonte: "Baymard Institute, Usability Testing of Inline Form Validation",
    fonte_url: "https://baymard.com/research-articles/inline-form-validation",
    tipo_fonte: "estudo",
    contexto: "Testes de usabilidade + avaliação de lojas grandes",
    areas: ["checkout"],
    evidencia:
      "31% das lojas não validam o campo na hora; nos testes, erro só no envio fazia parar, procurar o erro e às vezes desistir.",
    confiabilidade: "media",
    limitacoes:
      "Contagem de lojas + teste qualitativo; validar cedo demais (enquanto ainda digita) também atrapalha.",
    trecho:
      "Yet 31% of sites don’t have any inline validation at all — increasing friction for users who have errors",
  },
  {
    id: "cur-044",
    conhecimento:
      "Marque claramente o que é obrigatório e o que é opcional no formulário.",
    categoria: "ux",
    fonte:
      "Baymard Institute, Mark Both Required and Optional Fields Explicitly",
    fonte_url: "https://baymard.com/blog/required-optional-form-fields",
    tipo_fonte: "estudo",
    contexto: "Testes de usabilidade + avaliação de lojas grandes",
    areas: ["checkout"],
    evidencia:
      "Em formulários que só marcavam os opcionais, 32% dos participantes erraram por deixar um obrigatório vazio; só 14% das lojas marcam os dois.",
    confiabilidade: "media",
    limitacoes: "Amostra de teste pequena; não mede abandono final.",
    trecho:
      "However, when encountering forms where only the optional fields were marked, 32% of users during testing had a validation error because they did not complete a required field.",
  },
  {
    id: "cur-045",
    conhecimento:
      "Taxa que só aparece no fim faz muita gente desistir justamente no checkout.",
    categoria: "comercial",
    fonte:
      "Blake, Moshary, Sweeney & Tadelis, Price Salience and Product Choice (NBER WP 25186, 2018; Marketing Science, 2021)",
    fonte_url: "https://www.nber.org/papers/w25186.pdf",
    tipo_fonte: "estudo",
    contexto:
      "Experimento de campo no StubHub (ingressos, EUA), taxa média de ~15% do preço",
    areas: ["checkout", "carrinho", "frete_entrega", "titulo_preco"],
    evidencia:
      "Quem só via a taxa no fim escolhia mais ingressos (+19%), mas tinha quase 45% menos chance de comprar na etapa do checkout.",
    confiabilidade: "alta",
    limitacoes:
      "Ingressos, não moda. No total, esconder a taxa deu ~21% MAIS receita: o achado não é que mostrar cedo vende mais, é que a surpresa derruba no fim. Esconder custo é prática enganosa e não deve virar hipótese.",
    trecho:
      "In contrast, the drop off rate at the final stage (purchase) is much larger for BF users, as they are almost 45% less likely to purchase at checkout.",
  },
  {
    id: "cur-046",
    conhecimento:
      "Só melhorando o desenho do checkout, uma loja grande típica teria espaço pra converter bem mais.",
    categoria: "ux",
    fonte: "Baymard Institute, pesquisa anual de abandono de carrinho",
    fonte_url: "https://baymard.com/lists/cart-abandonment-rate",
    tipo_fonte: "estudo",
    contexto:
      "Projeção da Baymard a partir de 10 anos de testes de checkout em lojas grandes dos EUA e Europa",
    areas: ["checkout", "carrinho"],
    evidencia:
      "Estimativa: +35,26% de conversão pra uma loja grande média, corrigindo só problemas de usabilidade do checkout.",
    confiabilidade: "baixa",
    limitacoes:
      "Projeção da própria Baymard (que vende a pesquisa), não A/B; é teto teórico, não ganho esperado de uma mudança.",
    trecho:
      "the average large-sized ecommerce site can gain a 35.26% increase in conversion rate though better checkout design.",
  },
  {
    id: "cur-047",
    conhecimento:
      "Falta de forma de pagamento pesa menos no abandono do que custo e cadastro, mas aparece.",
    categoria: "comercial",
    fonte: "Baymard Institute, pesquisa anual de abandono de carrinho",
    fonte_url: "https://baymard.com/lists/cart-abandonment-rate",
    tipo_fonte: "estudo",
    contexto: "Compradoras online dos EUA, todos os segmentos",
    areas: ["checkout"],
    evidencia:
      "Tirando quem só olhava, 9% abandonaram por não haver formas de pagamento suficientes (contra 40% por custo extra, cur-001).",
    confiabilidade: "media",
    limitacoes:
      "Declarado, EUA (onde o cartão domina); no Brasil Pix e parcelamento mudam o peso; não diz quais formas faltavam.",
    trecho: "9% There weren't enough payment methods",
  },
  {
    id: "cur-048",
    conhecimento:
      "Mostre o total do pedido antes de pedir o cartão, principalmente no celular.",
    categoria: "comercial",
    fonte:
      "Baymard Institute, The State of Mobile Checkout & Form Usability (2015)",
    fonte_url:
      "https://baymard.com/research-articles/mobile-ecommerce-checkout-forms",
    tipo_fonte: "estudo",
    contexto: "Testes em celular + avaliação de 50 grandes lojas dos EUA, 2015",
    areas: ["checkout", "carrinho", "frete_entrega"],
    evidencia:
      "33% das lojas no celular não mostravam o total antes de pedir o cartão; nos testes, isso causou abandono direto.",
    confiabilidade: "media",
    limitacoes: "2015, lojas dos EUA; qualitativo, não quantifica o abandono.",
    trecho:
      "For example, 33% of the benchmarked mobile sites fail to display the total order cost – at any point during the checkout – before asking for credit card data.",
  },
  {
    id: "cur-049",
    conhecimento:
      "Selo de segurança conhecido passa mais confiança, mas metade das pessoas não tem preferência.",
    categoria: "confianca",
    fonte: "Baymard Institute, Which Site Seal do People Trust the Most?",
    fonte_url: "https://baymard.com/blog/site-seal-trust",
    tipo_fonte: "estudo",
    contexto:
      "Pesquisa com 2.510 adultos dos EUA (Google Consumer Surveys), jan/2013",
    areas: ["confianca", "checkout"],
    evidencia:
      "Norton foi o selo que mais passou confiança (~36% dos votos); 49% responderam 'não sei / sem preferência'.",
    confiabilidade: "media",
    limitacoes:
      "Declarado, EUA, 2013; selos diferentes dos usados no Brasil; não testou selo x nenhum selo nem mediu venda.",
    trecho:
      "Norton was shown to be the seal which gave customers the best sense of trust when purchasing online with ~36% of the votes.",
  },

  // ── Mobile ──────────────────────────────────────────────────────────────
  {
    id: "cur-050",
    conhecimento:
      "No celular, botões e links colados demais geram toque errado.",
    categoria: "ux",
    fonte: "Baymard Institute, 40+ UX Statistics",
    fonte_url: "https://baymard.com/blog/ux-statistics",
    tipo_fonte: "estudo",
    contexto: "Avaliação de sites móveis de lojas grandes",
    areas: ["pagina_geral", "card_produto", "filtros_ordenacao"],
    evidencia:
      "66% dos sites móveis põem elementos tocáveis perto demais e 32% têm alvos pequenos demais.",
    confiabilidade: "media",
    limitacoes:
      "Contagem de sites; não dá a distância mínima (ver cur-013) nem efeito em venda.",
    trecho:
      "66% of mobile sites place tappable elements too close to each other, and 32% of sites have tappable elements that are too small — both of which make it difficult for users to navigate the mobile interface reliably.",
  },
  {
    id: "cur-051",
    conhecimento:
      "No celular, campo de CEP, telefone, e-mail e cartão deve abrir o teclado certo.",
    categoria: "ux",
    fonte: "Baymard Institute, 40+ UX Statistics",
    fonte_url: "https://baymard.com/blog/ux-statistics",
    tipo_fonte: "estudo",
    contexto: "Avaliação de sites móveis de lojas grandes",
    areas: ["checkout"],
    evidencia:
      "61% dos sites móveis usam o teclado errado em pelo menos um campo, o que causa erro de digitação.",
    confiabilidade: "media",
    limitacoes: "Contagem de sites; não mede abandono.",
    trecho:
      "61% of mobile sites don’t use the correct keyboard layout (for example, a specialized numeric or email keyboard) for one or more form fields, which causes accidental typos.",
  },

  // ── Performance ─────────────────────────────────────────────────────────
  {
    id: "cur-052",
    conhecimento:
      "Página mais rápida, sem nenhuma outra mudança, vendeu mais num A/B.",
    categoria: "performance",
    fonte: "web.dev (Google), caso Vodafone",
    fonte_url: "https://web.dev/case-studies/vodafone",
    tipo_fonte: "ab_outra_loja",
    contexto:
      "Vodafone (telecom), landing page de mídia paga, A/B 50/50 com ~34 mil visitas/dia por versão, visual e função idênticos",
    areas: ["pagina_geral", "home_destaque"],
    evidencia:
      "A versão com LCP 31% melhor teve +8% de vendas e +11% na taxa carrinho/visita.",
    confiabilidade: "media",
    limitacoes:
      "Telecom, não moda; uma landing page, não o site; não publica significância nem duração; caso divulgado pelo Google.",
    trecho:
      "By running an A/B test specifically focused on optimizing Web Vitals, Vodafone found that a 31% improvement in LCP led to 8% more sales, a 15% improvement in their lead to visit rate, and a 11% improvement in their cart to visit rate.",
  },
  {
    id: "cur-053",
    conhecimento:
      "Otimizar Core Web Vitals de uma landing de varejo aumentou conversão e receita por visitante em A/B.",
    categoria: "performance",
    fonte: "web.dev (Google), caso Rakuten 24",
    fonte_url: "https://web.dev/case-studies/rakuten",
    tipo_fonte: "ab_outra_loja",
    contexto:
      "Rakuten 24 (varejo online, Japão), landing page com muito tráfego, A/B 50/50 por um mês",
    areas: ["pagina_geral"],
    evidencia:
      "Versão otimizada (CLS 92,7% melhor, 0,4 s mais rápida no celular) teve +33,1% de conversão e +53,4% de receita por visitante.",
    confiabilidade: "media",
    limitacoes:
      "Uma página só; ganho enorme sem intervalo de confiança publicado; caso divulgado pelo Google.",
    trecho:
      "Comparing the optimized version A to the unoptimized version B, Rakuten 24 found that version A brings about: 53.37% increase in revenue per visitor. 33.13% increase in conversion rate.",
  },
  {
    id: "cur-054",
    conhecimento:
      "Carregar primeiro as imagens da primeira tela e adiar as outras acelerou a PDP e deu ganho pequeno de conversão em A/B.",
    categoria: "performance",
    fonte: "web.dev (Google), caso Farfetch",
    fonte_url: "https://web.dev/case-studies/farfetch",
    tipo_fonte: "ab_outra_loja",
    contexto: "Farfetch (moda de luxo), páginas de produto",
    areas: ["galeria", "card_produto", "pagina_geral"],
    evidencia:
      "Na PDP a mudança tirou mais de 600 ms e o A/B mostrou +1% a +5% de conversão.",
    confiabilidade: "media",
    limitacoes:
      "Faixa larga; sem amostra, duração nem nível de confiança publicados; caso divulgado pelo Google.",
    trecho:
      "On product pages for example, this effort shaved off more than 600ms, and the A/B test showed an uplift on conversion rate in the range of 1-5% with the company's defined confidence level.",
  },
  {
    id: "cur-055",
    conhecimento:
      "Focar na velocidade do site no celular veio junto com mais receita mobile.",
    categoria: "performance",
    fonte: "web.dev (Google), caso Swappie",
    fonte_url: "https://web.dev/swappie",
    tipo_fonte: "estudo",
    contexto:
      "Swappie (loja de celulares recondicionados), antes/depois em 3 meses",
    areas: ["pagina_geral"],
    evidencia:
      "Com LCP 55% menor e CLS 91% menor, a conversão do celular relativa ao desktop foi de 24% pra 34% e a receita mobile subiu 42%.",
    confiabilidade: "baixa",
    limitacoes:
      "Antes/depois, não A/B: outras coisas mudaram nos 3 meses; caso divulgado pelo Google.",
    trecho:
      "After only three months of work, the impact was clear–Rel mCvR went from 24% to 34% and mobile revenue had increased 42%!",
  },
  {
    id: "cur-056",
    conhecimento:
      "Dar prioridade à imagem principal da primeira tela melhorou o carregamento em lojas brasileiras e veio junto com mais conversão.",
    categoria: "performance",
    fonte: "web.dev (Google), caso Nuvemshop",
    fonte_url: "https://web.dev/case-studies/nuvemshop",
    tipo_fonte: "estudo",
    contexto:
      "Lojas da Nuvemshop no Brasil, celular, visitas do Google orgânico, jan/2025 x jan/2026",
    areas: ["home_destaque", "galeria", "pagina_geral"],
    evidencia:
      "Lojas com LCP bom passaram de 57% pra 96% em um ano; no mesmo grupo de lojas, a conversão no celular subiu 8,9%.",
    confiabilidade: "baixa",
    limitacoes:
      "Ano contra ano, não A/B: sazonalidade e mudanças das lojas se misturam; a plataforma divulga o próprio resultado junto com o Google.",
    trecho:
      "Analyzing the same cohort of Brazilian stores active in Jan 2025 and Jan 2026, mobile visitors from Google organic search showed: 8.9% increase in conversion rate (session-to-paid-order)",
  },
  {
    id: "cur-057",
    conhecimento:
      "A resposta ao toque (abrir filtro, menu, trocar foto) deve vir em até 200 ms.",
    categoria: "performance",
    fonte: "web.dev (Google), Interaction to Next Paint (INP)",
    fonte_url: "https://web.dev/articles/inp",
    tipo_fonte: "boa_pratica",
    contexto: "Core Web Vitals, todas as páginas",
    areas: ["filtros_ordenacao", "menu_busca", "pagina_geral"],
    evidencia: "INP ≤ 200 ms = bom; acima de 500 ms = ruim (percentil 75).",
    confiabilidade: "alta",
    limitacoes: "Limiar de experiência; não mede efeito em venda.",
    trecho:
      "Good INP values are 200 milliseconds or less. Poor values are greater than 500 milliseconds.",
  },
];

/** Literal quote (original language) backing the `evidencia` of cur-001..015. */
export const EXISTING_TRECHOS: Record<string, string> = {
  "cur-001":
    "40% Extra costs too high (shipping, tax, fees) 20% Delivery was too slow",
  "cur-002": "19% I didn't trust the site with my credit card information",
  "cur-003":
    "In our most recent study, users spent about 57% of their page-viewing time above the fold. 74% of the viewing time was spent in the first two screenfuls, up to 2160px.",
  "cur-004":
    "The average difference in how users treat info above vs. below the fold is 84%.",
  "cur-005":
    "User transactions were measured to increase by 8.4% when there was a 0.1 second improvement in the 4 site speed metrics.",
  "cur-006":
    "Good LCP values are 2.5 seconds or less, poor values are greater than 4.0 seconds, and anything in between needs improvement",
  "cur-007":
    "Good CLS values are 0.1 or less. Poor values are greater than 0.25.",
  "cur-008":
    "Nearly 30% (31) of the consumers in the limited-choice condition subsequently purchased a jar of Wilkin & Sons jam; in contrast, only 3% (4) of the consumers in the extensive-choice condition did so",
  "cur-009":
    "In a meta-analysis of 63 conditions from 50 published and unpublished experiments (N = 5,036), we found a mean effect size of virtually zero but considerable variance between studies.",
  "cur-010":
    "The purchase likelihood for a product with five reviews is 270% greater than the purchase likelihood of a product with no reviews.",
  "cur-011":
    "The movement time to a target depends on the size of the target and the distance to the target.",
  "cur-012": "one handed—49% cradled—36% two handed—15%",
  "cur-013":
    "The size of the target for pointer inputs is at least 44 by 44 CSS pixels except when:",
  "cur-014":
    "users pay attention to information-carrying images that show content that's relevant to the task at hand. And users ignore purely decorative images that don't add real content to the page.",
  "cur-015":
    "First lines of text on a page receive more gazes than subsequent lines of text on the same page. First few words on the left of each line of text receive more fixations than subsequent words on the same line.",
};
