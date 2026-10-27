# Board — esteira de conteúdo (execução manual)

Emulação manual da esteira de conteúdo: uma coluna por automação futura, cada
uma invocada à mão como skill do Claude Code, levando um card do começo ao fim.

Existe pra responder uma pergunta antes de a automação ser construída: **a
esteira encaixa no modelo de rodar Claude Code com skills, e o que dela não dá
pra ser skill?** A resposta vive em `README.md`, ao lado.

**Status é campo, não seção.** É como o board de Posts do Studio funciona —
`postStatus` / `setPostStatus` em `blog-data.ts`, com as raias derivadas como
visão. Mover um card aqui é trocar uma célula, idempotente. Um board recortado
em seções precisaria de duas edições e perderia o card se a segunda não
acontecesse.

## Colunas

| Coluna | Fase | Dono na automação | Skill | Espera por |
|---|---|---|---|---|
| `hipótese` | plan | um gatilho (não existe ainda) | `blog-hipotese` | alguém ter a ideia |
| `estratégia` | plan | Estrategista | `blog-estrategista` | campanha + formato + os blocos do site |
| `redação` | execute | Redator | `blog-redator` | o rascunho |
| `ilustração` | execute | Ilustrador | `blog-ilustrador` | a capa |
| `montagem` | execute | Redator (2ª visita) | `blog-montagem` | payload + links + commit |
| `revisão` | monitor | pessoa | — | alguém ler o rascunho |

Os quatro papéis são os mesmos de `apps/api/src/file-storage/project-agents.ts`,
com os mesmos belts — a coluna manual transcreve direto no agente.

**O Redator aparece duas vezes.** Ele é dono de `BLOG_POST_WRITE`, mas a
gravação precisa da capa, que o Ilustrador faz, que precisa do prompt, que o
rascunho faz. No navegador essa volta some dentro de uma função; numa esteira
de papéis ela é uma dependência, e o board mostra.

## Checkpoints

Dois, e os dois são humanos de propósito.

1. **Depois de `estratégia`** — campanha e formato certos pra esta hipótese?
   Tudo depois custa dinheiro e minutos; é o único ponto barato de corrigir.
2. **Depois de `montagem`** — o rascunho presta? Estrutural, não disciplina:
   o bloco é gravado sem `__resolveType`, então a loja não o resolve qualquer
   que seja o status. Publicar é ato de pessoa.

## Cards

| # | Card | Coluna | Status no Studio | Atualizado |
|---|---|---|---|---|
| 001 | Guia de volta às aulas por perfil | `revisão` | `awaiting_review` | 2026-10-26 11:35 |

### 001 — Guia de volta às aulas por perfil

**Hipótese.** Quem busca mochila de volta às aulas chega com um perfil na
cabeça — idade, série, o que cabe — e não com um produto. Um guia organizado
por perfil deve converter melhor que uma lista de produtos. — origem: run de
teste da esteira, 2026-10-26

Gravada como `post.planning.brief`.

| Campo | Valor |
|---|---|
| Campanha | volta às aulas, segmento infantil — 15 produtos |
| Formato | Guia de compra para volta às aulas |
| Bloco | `blog-manager/posts/7206eee7e547` |
| Commit | `b0777334f9` em `main` |
| Seções | 26 |

**Log**

- `11:30` `blog-hipotese` — card aberto
- `11:30` `blog-estrategista` — estado lido (2 campanhas, 1 formato); decofile
  4,9 MB e manifesto 1,9 MB pelo dreno; gate de marca passou;
  `blocksForFormat` → 10 blocos de 19 que o site expõe (CallToAction, Callout,
  Checklist, Heading, BlockImage, List, Paragraph, ProductCard, ProductShelf,
  Steps); 22 categorias, 1 autor

  *Este run é anterior a `BLOG_SITE_BLOCKS`. Os mesmos dez blocos hoje vêm de
  uma chamada, sem decofile nem manifesto passando por lugar nenhum.*
- `11:32` `blog-estrategista` — `BLOG_SITE_GROUND` `outcome=ok`, 314 ferramentas
  alcançadas, 600k chars de evidência
- `11:33` `blog-redator` — `BLOG_POST_DRAFT` 1 post, **26 seções, `gaps=[]`**,
  8 produtos da campanha citados
- `11:34` `blog-ilustrador` — 1 bucket; 12 fotos oferecidas,
  `outcome=ok`, `referenced=3` (o teto)
- `11:35` `blog-montagem` — 228 candidatos a link, 6 sugestões, **3 aplicadas**;
  `assemble` **26 seções mantidas, 0 descartadas**; `BLOG_POST_WRITE` →
  `b0777334f9`
- `11:36` **checkpoint 2** — rascunho no board de Posts como *Aguardando
  revisão*, com capa, produtos nos slots e links internos. Aguardando leitura.

**Divergências com o navegador, declaradas**

- O navegador faz um segundo embasamento com `purpose: "link"`; aqui o de
  `post` foi reusado. Uma chamada a menos, de propósito.
- O navegador escreve a nota da campanha em `planning.brief`; aqui vai a
  hipótese do card, que é a camada acima. Serve o requisito de não perder a
  origem do que foi executado.

**O que o run ensinou, e o que foi feito com isso**

- O eval do CDP corta em **45s** e três tools passam disso (embasamento 75s,
  rascunho ~100s, cada imagem 90s). Esperar dentro da aba devolvia
  `Runtime.evaluate timed out` com a requisição ainda viva e cobrando.
- Os dois payloads grandes — decofile 4,9 MB, manifesto 1,9 MB — não cabiam num
  resultado de ferramenta em direção nenhuma, e precisaram de um dreno local.

As duas foram embora juntas. `BLOG_SITE_BLOCKS` lê os dois do lado do servidor
e devolve só os blocos; `BLOG_POST_ASSEMBLE` faz a volta. Sem aba, sem dreno,
sem script, e nada disso tem teto de 45s.

<!--
Modelo de card. Artefatos do run ficam em .blog-pipeline/runs/<id>/, fora do
git: carregam perfil de marca, URL de loja e ids de produto.
Arquivos de um run hoje: blog-state.json, blocks.json, grounding.json,
draft.json, photos.json, cover.json, assembled.json, links.json, post.json,
write.json.

### 001 — <título de trabalho>

**Hipótese.** <o que se acredita e por quê> — origem: <de onde veio>, <data>

Vira `post.planning.brief` na gravação.

| Campo | Valor |
|---|---|
| Campanha | <nome> |
| Formato | <nome> |
| Post id | <postId> |
| Bloco | blog-manager/posts/<postId> |
| Commit | <sha> |

**Log**

- `hh:mm` `blog-hipotese` — card aberto
- `hh:mm` `blog-estrategista` — N campanhas, N formatos; gate de marca passou;
  blocksForFormat → N blocos (<nomes>); BLOG_SITE_GROUND outcome=<...>
- `hh:mm` **checkpoint 1** — confirmado
- `hh:mm` `blog-redator` — N seções (<tipos>), gaps=[...]
- `hh:mm` `blog-ilustrador` — N buckets; outcome=<...>, referenced=N
- `hh:mm` `blog-montagem` — N de N links aplicados; N seções descartadas;
  BLOG_POST_WRITE → <sha>
- `hh:mm` **checkpoint 2** — aguardando leitura
-->
