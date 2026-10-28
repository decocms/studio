---
name: blog-redator
description: Third column of the content pipeline — write the post itself from the brief and the grounding, against the site's own block schemas. Use after blog-estrategista and its human checkpoint.
disable-model-invocation: true
---

# Coluna `redação` — escrever o post

Coluna fina de propósito: o estado e os blocos que a coluna anterior leu já
são o argumento inteiro. Uma chamada.

## Pré-requisito

O checkpoint humano da `estratégia` passou — alguém confirmou campanha e
formato. Se não passou, volte e pergunte.

## O que fazer

### 1. Rascunhar

Com `blog-state.json`, `blocks.json` e `grounding.json` do run:

```bash
t BLOG_POST_DRAFT "$(bun -e '
  const st = await Bun.file(process.env.RUN+"/blog-state.json").json();
  const bl = await Bun.file(process.env.RUN+"/blocks.json").json();
  const g = await Bun.file(process.env.RUN+"/grounding.json").json();
  const campaign = st.campaigns.find(c => c.id === process.env.CAMPAIGN) ?? st.campaigns[0];
  const format = (st.formats?.formats ?? [])[0];
  console.log(JSON.stringify({ virtualMcpId: process.env.VMCP,
    brand: { ...st.brand, ...st.context },
    campaign: { ...campaign.data, name: campaign.data.campaignName }, format,
    blocks: bl.blocks, categories: bl.categories, authors: bl.authors, count: 1,
    grounding: { report: g.report, outcome: g.outcome } }));')" draft.json
```

**Não passe `fileConfigId`.** A capa é desenhada na coluna seguinte, e essa
separação existe exatamente pra esta chamada ficar sob o limite de ~100s do
edge. Passar o bucket aqui é como a chamada volta 524.

O `grounding` é opcional. Omitir não é de graça: o servidor roda um
embasamento próprio de 45s dentro desta mesma requisição
(`INLINE_GROUNDING_TIMEOUT_MS`), e aí o orçamento aperta. Passe o que a coluna
anterior já pagou.

### 2. Ler o que voltou

Três coisas pra conferir antes de mover o card:

- **`gaps[]`** — códigos (`no-store-data`, `sections-dropped`, `no-bucket`,
  `no-image-model`, `images-failed`, `drafts-failed`). Copie **verbatim** pro
  log do card. `no-bucket` aqui é esperado e correto: você não passou bucket.
- **`sections[].type`** — os nomes de bloco que ele escolheu. Se vier um tipo
  que não está em `blocks.json`, a montagem vai descartar a seção em silêncio.
- **`cover.prompt`** — a coluna seguinte depende dele. Se vier vazio, não há
  capa pra desenhar.

Se `posts` vier vazio, o gap é `drafts-failed`: o modelo não conseguiu produzir
nada que casasse com o schema. Releia os `blocks` do brief — em geral é schema
grande demais ou um formato citando bloco que o site não tem.

### 3. Mover o card

Card para `redação`. Log com: quantas seções, quais tipos, os gaps verbatim, e
se a capa veio com prompt.

Siga direto pra `blog-ilustrador` — não há decisão humana entre as duas.
