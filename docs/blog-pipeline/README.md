# A esteira de conteúdo

O caminho de um blogpost pela aba Content do Executar: um card por post,
trabalhado por um agente — o Super Agent, no Claude Code, dentro de um
sandbox, com a skill `blogpost` —, e duas decisões de pessoa no meio.

Quem pensa e escreve é o Claude Code: ele lê os sistemas da loja, argumenta a
hipótese e escreve o post. As tools do Studio dão o que só o Studio tem (o
card, a marca, os blocos do site, as imagens) e conferem e gravam o que ele
escreveu. Toda a IA do blog roda assim, na esteira: o card, o preenchimento da
marca e as campanhas. Nenhuma tool de blog chama modelo dentro da api, exceto
a de imagem, e só no run do próprio card.

## O fluxo

1. **A marca preenchida**, em Contexto → Marca. Sem ela o Content mostra o
   setup e nada mais é possível. O "Preencher com IA" abre um chat do agente
   (`BLOG_BRAND_FILL`), que lê o repositório do site e os sistemas da loja.
2. **Uma campanha**, em Content → Campanhas, lida da conexão VTEX da org. A
   meta dela (`goal`: o texto, a métrica e o alvo, até o fim do período) é
   posta por uma pessoa; nenhum modelo propõe alvo. Ninguém cria campanha do
   zero: "Sugerir campanhas" (`BLOG_CAMPAIGN_RUN`) cria um rascunho e abre o
   chat dele. O agente segue o `campaigns.md`: grava a evidência, sugere três
   briefings, e desenvolve o que a pessoa escolher ou escrever. Tudo chega ao
   vivo pelo `brand.updated`. Aprovar e pôr a meta continuam sendo da pessoa.
3. **Novo blogpost.** `BLOG_CARD_CREATE` cria o card em Ideas, para um site e,
   quando a pessoa escolhe, uma campanha aprovada. Sem campanha, o card começa
   pela fase Campanha: `BLOG_CARD_RUN` com `phase: "campaign"` cria um rascunho
   ligado ao card, que nomeia o chat do card, e o agente sugere briefings e
   desenvolve o escolhido ali mesmo. Quando a pessoa aprova a campanha, ou
   quando o card já nasce com uma, `BLOG_CARD_RUN` com `phase: "hypothesis"`
   começa a hipótese. Uma pessoa só liga ao card campanha aprovada, e um run
   nunca troca a campanha do card. Se o card larga a campanha nascida nele, o
   rascunho é apagado, e uma campanha já aprovada só perde o chat.
   O post é da campanha: o agente parte dela e da meta, pergunta à VTEX, ao GA4
   e ao Search Console (`CONNECTION_TOOL_CALL`), grava a evidência no card,
   depois a hipótese, com o `objective` do post como a parte dele na meta,
   apresenta no chat do card e espera.
4. **A hipótese aprovada.** A pessoa ajusta no chat ou aprova no card, que
   chama `BLOG_CARD_RUN` com `phase: "execute"`. O card vai pra Generating, na
   branch `blog-<id>` do site, e passa por cinco etapas — `grounding`,
   `drafting`, `illustrating`, `assembling` e `writing` —, cada uma gravando
   `stage` e o que produziu. O post sai das instruções de `BLOG_POST_BRIEF`
   (as regras e a leitura de marca, campanha e blocos), e o
   `BLOG_POST_ASSEMBLE` confere cada seção contra o schema do bloco,
   devolvendo o motivo do que cortou. Termina
   em Awaiting review, com `postKey` e `commit`.
5. **Revisão**, no próprio card: o site renderiza o post a partir da branch do
   card, pelo ponteiro de rascunho do Fast Preview (`?__draft=`), sem sandbox.
   Pede o servidor de prévia do projeto e o CMS no plano; sem eles, o card
   mostra o post como conteúdo. **Publicação**, no Site Editor, por uma
   pessoa: o card abre o editor na branch do card, por um chat dele com id
   fixo por card e pessoa (`cardEditorThreadId`).
6. **Monitor**: ainda não existe.

## Onde as coisas moram

| O quê | Onde |
| --- | --- |
| O card | `home/brands/<marca>/cards/<id>.json`, schema em `@decocms/shared/blog-card` |
| As campanhas | `home/brands/<marca>/campaigns/<id>.json` |
| O guia da marca | `home/brands/<marca>/brand.md` |
| O chat do card | Uma thread do Super Agent no Claude Code, com id fixo por card (`blogCardThreadId`) e marcada com `metadata.blogCard` |
| O chat de um job | Uma thread do Super Agent no Claude Code, marcada com `metadata.blogJob` (`brand-fill` ou `campaigns`) |
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

## Os jobs fora do card

| Tool | Quem chama | O que faz |
| --- | --- | --- |
| `BLOG_BRAND_FILL` | A página da marca e o setup do Content | Abre um chat que preenche o guia da marca |
| `BLOG_CAMPAIGN_RUN` | "Sugerir campanhas" e a página da campanha | Cria o rascunho e o chat dele, ou dá o próximo passo: desenvolver o briefing escolhido |

Os chats não recebem nenhuma das duas: só uma pessoa começa um job.

Uma campanha muda pelo `BLOG_CAMPAIGN_UPDATE`, por merge, como o card. O
registro aponta o chat que a molda (`threadId`), e só esse chat a escreve, sem
nunca mandar `status` nem `goal`. A pessoa só manda esses dois: nunca volta uma
campanha aprovada para rascunho, e só aprova uma já desenvolvida. O
`BLOG_STATE_SET` recusa toda escrita de agente em campanha ou semente, e toda
remoção.

## O modelo do run

O run do card e o de um job começam no modelo da org e, sem nenhum, no plano
Claude de quem disparou, como o chat (`dispatchSuperAgentTurn`). No despacho o plano tem prioridade
sobre a chave da org de todo jeito. Imagem é a exceção: o Claude não gera
imagem, então `BLOG_POST_ILLUSTRATE` precisa de um modelo de imagem da org, e
sem ele o post sai sem imagens e com a lacuna `no-image-model`. Ela só atende o
run do próprio card (`requireCardRun`): a marca da thread não basta, porque
qualquer um pode escrevê-la, então o card também tem de apontar o chat. Para a web, o
agente usa o `WebSearch` e o `WebFetch` do próprio Claude Code: o
`web_search` do Studio precisa do modelo da org.

## O acesso às conexões

A chave de um run de chat só alcança as conexões que o agente agrega, e o
Super Agent não agrega nenhuma. Sem tratamento, o embasamento do card chamaria
a VTEX e o GA4, tomaria acesso negado em toda chamada e responderia `ok` em
cima de nenhum dado.

Por isso `sandbox-dispatch-client.ts` dá à chave de um chat marcado com
`metadata.blogCard` ou `metadata.blogJob`, com `blog_ai_enabled` ligado, as conexões do blog
(`blogCardRunConnections`): a VTEX só com as tools de embasamento
(`VTEX_GROUNDING_TOOLS`, via `narrowConnectionGrants`), o GA4 e o Search
Console inteiros. Elas entram só na chave, sem montagem no Claude Code: o
agente as acha com `CONNECTION_TOOLS_SEARCH` e chama com
`CONNECTION_TOOL_CALL`, sempre limitado ao que quem disparou pode chamar.

O Search Console é opcional: entra na evidência quando está conectado, e nunca
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
  depois disso, com o servidor ainda trabalhando e cobrando. Com a escrita no
  Claude Code, só a imagem chega perto: uma por chamada.
- **O primeiro turno do card sobe um sandbox do zero.** O card é o registro
  durável, então perder a sessão custa tempo, não trabalho. Sugerir campanhas
  também sobe um, então os briefings levam alguns minutos.
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
