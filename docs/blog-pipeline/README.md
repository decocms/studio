# A esteira de conteúdo

O caminho de um blogpost pela aba Content do Executar: um card por post,
trabalhado por um agente — o Super Agent, no Claude Code, dentro de um
sandbox, com a skill `blogpost` —, e duas decisões de pessoa no meio.

## O fluxo

1. **A marca preenchida**, em Contexto → Marca. Sem ela o Content mostra o
   setup e nada mais é possível.
2. **Uma campanha**, em Content → Campanhas, lida da conexão VTEX da org.
3. **Novo blogpost.** `BLOG_CARD_CREATE` cria o card em Ideas, para um site e
   uma campanha, e `BLOG_CARD_RUN` com `phase: "hypothesis"` começa o agente.
   Ele embasa (`BLOG_SITE_GROUND` com `purpose: "hypothesis"`), grava a
   evidência no card, depois a hipótese, apresenta no chat do card e espera.
4. **A hipótese aprovada.** A pessoa ajusta no chat ou aprova no card, que
   chama `BLOG_CARD_RUN` com `phase: "execute"`. O card vai pra Generating, na
   branch `blog-<id>` do site, e passa por cinco etapas — `grounding`,
   `drafting`, `illustrating`, `assembling` e `writing` —, cada uma gravando
   `stage` e o que produziu. Termina em Awaiting review, com `postKey` e
   `commit`.
5. **Revisão e publicação**, no Site Editor, por uma pessoa.
6. **Monitor**: ainda não existe.

## Onde as coisas moram

| O quê | Onde |
| --- | --- |
| O card | `home/brands/<marca>/cards/<id>.json`, schema em `@decocms/shared/blog-card` |
| As campanhas | `home/brands/<marca>/campaigns/<id>.json` |
| O guia da marca | `home/brands/<marca>/brand.md` |
| O chat do card | Uma thread do Super Agent no Claude Code, com id fixo por card (`blogCardThreadId`) e marcada com `metadata.blogCard` |
| O rascunho | `blog-manager/posts/<id>`, na branch `blog-<id>` do site |
| A skill | `packages/sandbox/image/skills/blogpost/`, no conjunto público `core` |

O id do card é o id do post: o rascunho e a branch levam o nome dele.

## As tools do card

| Tool | Quem chama | O que faz |
| --- | --- | --- |
| `BLOG_CARD_LIST` | O board | Os cards da org, ou de um site |
| `BLOG_CARD_GET` | O agente, no começo de cada turno | Um card e a versão dele |
| `BLOG_CARD_CREATE` | O board | Um card novo em Ideas |
| `BLOG_CARD_UPDATE` | O agente e o board | Um patch mesclado no card |
| `BLOG_CARD_DELETE` | O board | Apaga o card; o chat, a branch e o rascunho ficam |
| `BLOG_CARD_RUN` | O board | Começa uma fase no chat do card |

Os chats não recebem `BLOG_CARD_RUN` nem `BLOG_CARD_DELETE`: o agente trabalha
o card, e começar run e apagar card é do board.

### Quem muda o status

| Status | Quem define |
| --- | --- |
| `ideas` | A criação, ou uma pessoa |
| `generating` | Só o `BLOG_CARD_RUN`, na execução |
| `awaiting_review` | O run do próprio card, ou uma pessoa |
| `scheduled`, `published` | Só uma pessoa |

Um run escreve só no card do próprio chat (`cardPatchRefusal`).

### Escrita concorrente

O agente e a pessoa escrevem no mesmo card. `BLOG_CARD_UPDATE` mescla o patch
no card guardado e relê quando outra escrita cai no meio, até três vezes; com
`expect`, recusa em vez de mesclar. Duas escritas no mesmo instante ainda
podem se sobrepor: o `OrgFs.write` confere a versão contra a linha do
manifesto que leu, não de forma atômica com a própria escrita.

## O acesso às conexões

A chave de um run de chat só alcança as conexões que o agente agrega, e o
Super Agent não agrega nenhuma. Sem tratamento, o embasamento do card chamaria
a VTEX e o GA4, tomaria acesso negado em toda chamada e responderia `ok` em
cima de nenhum dado.

Por isso `sandbox-dispatch-client.ts` dá à chave de um chat marcado com
`metadata.blogCard`, com `blog_ai_enabled` ligado, as conexões do blog
(`blogCardRunConnections`): a VTEX só com as tools de embasamento
(`VTEX_GROUNDING_TOOLS`, via `narrowConnectionGrants`), o GA4 e o Search
Console inteiros. Elas entram só na chave, sem montagem no Claude Code, e
continuam limitadas ao que quem disparou pode chamar.

O Search Console é opcional: entra no embasamento quando está pronto, e nunca
é motivo de recusa. VTEX e GA4 são obrigatórios.

## A branch

Toda tool que lê ou grava o site cai na branch da thread quando `branch` é
omitido, e recusa quando não há nenhuma (`resolveSiteBranch`). Uma chave de
sandbox (`thread:…`) passada como branch é recusada; a do próprio chat só vira
a ref do checkout quando o sandbox clonou o repositório do site.
`BLOG_POST_WRITE` recusa a branch padrão do repositório: ela é produção, e um
teste manual desta esteira já gravou um post direto na `main`.

## Os limites

- **Cerca de 100 segundos por chamada.** Um proxy de borda desliga a conexão
  depois disso, com o servidor ainda trabalhando e cobrando. A skill quebra o
  trabalho em chamadas curtas: um embasamento repassado adiante, rascunho com
  `count: 1` e sem bucket, uma imagem por chamada, e nunca
  `BLOG_CAMPAIGN_SUGGEST`.
- **O primeiro turno do card sobe um sandbox do zero.** O card é o registro
  durável, então perder a sessão custa tempo, não trabalho.
- **As branches `blog-<id>` se acumulam** até alguém publicar ou limpar.

## O que honestamente não dá pra ser skill

1. **O mapeamento de blocos, como instrução.** Pode ser *código* chamado por
   skill, não *prosa* de skill. `rawBlockSchema` tem um fallback silencioso de
   orçamento que muda a forma do schema em site grande; `reconciledSchema`
   deixa o exemplo guardado sobrepor o `type` do schema; `requiredOf` existe
   porque um entendimento em prosa já errou isso uma vez; `writeProductListIds`
   preserva quatro formatos distintos de slot de produto. Prosa aqui é um fork
   sem teste de código testado. É por isso que virou `packages/shared/src/blog/`
   e as tools `BLOG_SITE_BLOCKS` e `BLOG_POST_ASSEMBLE`.

2. **Publicar.** A promoção de `blog-manager/posts/<id>` para
   `collections/blog/posts/<id>` é uma mutação do Site Editor, e não existe
   tool por trás. Não é skill que falta: é capacidade que a plataforma não
   expõe de propósito, e é a razão de a esteira ser segura de automatizar —
   nada que ela escreve alcança um leitor sozinho.

3. **Tempo.** Skill roda quando invocada. Nada dentro dela acorda numa data de
   campanha, num movimento do Search Console ou num sinal de estoque. Quem
   começa um card hoje é uma pessoa, no Novo blogpost; um gatilho com agenda
   seria um objeto do Studio, não uma skill.

4. **Julgamento editorial.** "Esta hipótese merece um post" e "este rascunho
   presta" não são mecânicos, e nenhum prompt os torna mecânicos. O agente
   apresenta e para; aprovar a hipótese e revisar o rascunho são as duas
   decisões de pessoa da esteira.
