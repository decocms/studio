# A esteira de conteúdo rodando como Claude Code + skills

Isto é a emulação manual pedida antes de a esteira virar automação: cinco
skills, um board markdown, e um post de verdade levado do começo ao fim.

A pergunta que ela responde: **a esteira encaixa no modelo de rodar Claude Code
com algumas skills, ou é código determinístico chamando API de modelo?**

Resposta curta: **é o segundo, e a parte determinística é a que vale a pena.**

## Como rodar no seu próprio Claude Code

É pra isso que isto existe: a esteira inteira num Claude Code com shell, sem
browser no meio, sem checkout do Studio e sem sandbox.

**1. Uma chave de API.** Configurações → Chaves de API, com esta allowlist:

```
BLOG_STATE_GET   BLOG_STATE_SET      BLOG_SITE_BLOCKS   BLOG_SITE_GROUND
BLOG_SITE_CATALOGUE   BLOG_POST_DRAFT   BLOG_POST_ILLUSTRATE
BLOG_POST_ASSEMBLE    BLOG_LINK_SUGGEST  BLOG_POST_WRITE   FILE_CONFIG_LIST
```

**2. O ambiente:**

```bash
export STUDIO_API_KEY=...
export STUDIO=http://localhost:3000
export ORG=<slug>  VMCP=vir_...  BRANCH=<branch>  FOLDER=<pasta-do-projeto>
export RUN=.blog-pipeline/runs/001
```

**3. As colunas**, uma invocação cada:

```
/blog-hipotese      → abre o card
/blog-estrategista  → estado, blocos do site, embasamento   ⟵ checkpoint humano
/blog-redator       → o rascunho
/blog-ilustrador    → capa e imagens do corpo
/blog-montagem      → montagem, links, commit               ⟵ checkpoint humano
```

Todas são `disable-model-invocation: true`: gastam dinheiro de verdade e são
invocadas de propósito, uma coluna por vez. É isso que é a demo.

### O que roda no seu Claude e o que não

Com a chave, **a orquestração inteira é sua** — qual campanha, o que pedir, em
que ordem, o que fazer com o que voltou.

As tools de geração continuam gastando a chave de modelo da org: cada uma chama
um modelo do lado do servidor. As que não chamam modelo nenhum e são puro
estado, leitura e persistência: `BLOG_STATE_GET`, `BLOG_STATE_SET`,
`BLOG_SITE_BLOCKS`, `BLOG_POST_ASSEMBLE`, `BLOG_POST_WRITE` e
`FILE_CONFIG_LIST`. O sinal confiável é `requiresAiBudget` na declaração da
tool, não um grep por `resolveTier`.

### Branch

Toda tool que lê ou grava o site cai na branch da thread quando `branch` é
omitido, e **recusa** quando não há nenhuma. A default do repositório é
produção, e adivinhá-la já colocou dois posts gerados direto na `main` de um
cliente. Não adivinhe.

## O mesmo caminho, sem CLI

As mesmas tools rodam no harness `decopilot`, in-process, sem pod de sandbox.
Os quatro papéis de `apps/api/src/file-storage/project-agents.ts` são os
subagents, cada um com seu belt, e o Board do Studio é o board. A diferença
entre as duas execuções é quem orquestra, não o que é chamado.

## O que honestamente não dá pra ser skill

1. **O mapeamento de blocos, como instrução.** Pode ser *código* chamado por
   skill, não pode ser *prosa* de skill. `rawBlockSchema` tem um fallback
   silencioso de orçamento que muda a forma do schema em site grande;
   `reconciledSchema` deixa o exemplo stored sobrepor o `type` do schema;
   `requiredOf` existe porque um entendimento em prosa já errou isso uma vez —
   o comentário no código nomeia o bug; `writeProductListIds` preserva quatro
   formatos distintos de slot de produto. Prosa aqui é um fork sem teste de
   código testado. **Permanente** — e é por isso que virou
   `packages/shared/src/blog/` e duas tools em vez de instrução.

2. **Publicar.** A promoção de `blog-manager/posts/<id>` para
   `collections/blog/posts/<id>` é `movePostToStatus`, mutação do navegador.
   Não existe tool por trás. Não é skill que falta: é capacidade que a
   plataforma deliberadamente não expõe. **Permanente, e é a razão de a esteira
   ser segura de automatizar** — nada que ela escreve alcança um leitor
   sozinho.

3. **Tempo.** Skill roda quando invocada. Nada dentro de uma acorda numa data
   de campanha, num movimento do Search Console ou num sinal de estoque. A
   automação real da primeira coluna é um trigger do Studio, com agenda e
   token. Nesta rodada a pessoa é o gatilho, e `blog-hipotese` existe pra
   tornar essa substituição visível. **Permanente.**

4. **Julgamento editorial nos dois checkpoints.** O gate de marca é mecânico e
   está no código. "Esta hipótese merece um post" e "este rascunho presta" não
   são, e nenhum prompt faz virarem. Uma skill apresenta, registra e se recusa
   a seguir. Não decide. **Permanente — e é por isso que os cortes entre as
   skills caíram exatamente aqui.**

Menção honrosa: **concorrência.** `enqueueDecofilePatch` serializa por
`decofileQueueKey`, então a escrita da esteira e a do editor não se corrompem.
Mas uma skill consegue repetir, não consegue segurar lock. Irrelevante com um
card, questão real no terceiro.

### Uma que saiu da lista

**Autenticação** estava aqui: a API lia cookie de sessão e skill roda em shell
sem cookie, então o transporte era `fetch` dentro de uma aba logada. Resolvido
com chave de API de allowlist — `context-factory.ts` aceita o principal de
chave, e as duas rotas HTTP de decofile de que a esteira dependia sumiram
quando `BLOG_SITE_BLOCKS` passou a ler o repositório do lado do servidor.
