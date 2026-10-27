---
name: blog-ilustrador
description: Fourth column of the content pipeline — draw the post's cover, conditioned on the campaign's own product photographs, and upload it where the site can load it. Use after blog-redator.
disable-model-invocation: true
---

# Coluna `ilustração` — desenhar as imagens

Na automação real esta coluna é o **Ilustrador**, belt
`FILE_CONFIG_LIST, BLOG_POST_ILLUSTRATE`.

O `FILE_CONFIG_LIST` no belt não é enfeite: `BLOG_POST_ILLUSTRATE` exige
`fileConfigId` e **não desenha nada sem ele** — sem poder listar os buckets, o
papel não tem como descobrir pra onde subir a imagem.

## O que fazer

### 1. Achar o bucket

```bash
t FILE_CONFIG_LIST '{}' file-configs.json
bun -e 'const c=await Bun.file(process.env.RUN+"/file-configs.json").json();
  console.log(c.configs.map(x=>`${x.id}  ${x.name}  ${x.bucket}`).join("\n"));'
```

Um só: use. Vários: pergunte ao usuário qual. Nenhum: **pare e diga**. É
configuração que alguém tem que fazer, não algo pra contornar — o post segue
sem capa, e isso vai no card como fato.

### 2. Juntar as fotos e a sua própria orientação

Primeiro traga seu `AGENT.md` pro run, porque a orientação sai de lá:

```bash
curl -sS -H "Authorization: Bearer $STUDIO_API_KEY" \
  "$STUDIO/api/$ORG/fs/home/read?path=projects/$FOLDER/agents/ilustrador/AGENT.md" \
  -o "$RUN/agent-ilustrador.md"
```

```bash
bun -e 'const { referencePhotos } = await import("@decocms/shared/blog");
  const s = await Bun.file(process.env.RUN+"/blog-state.json").json();
  const c = s.campaigns.find(c => c.id === process.env.CAMPAIGN) ?? s.campaigns[0];
  const md = await Bun.file(process.env.RUN+"/agent-ilustrador.md").text();
  const guidance = (md.split(/^## How this brand.s pictures should look$/m)[1] ?? "")
    .split(/^## /m)[0].trim();
  await Bun.write(process.env.RUN+"/photos.json", JSON.stringify({
    productImages: referencePhotos(c.data.intent?.products ?? []), guidance }));'
```

`referencePhotos` pega uma foto de cada produto antes da segunda de qualquer
um, com teto de 12. A ordem importa: gastar a cota toda nos primeiros itens faz
a referência descrever um produto em vez da faixa sobre a qual o post é. É a
mesma função que o navegador usa — `@decocms/shared/blog`, não uma cópia.

O `guidance` sai da seção `## How this brand's pictures should look` do seu
`AGENT.md` — semeada com um default e editável no CMS. É o que faz "mostre o
produto real" ser coisa que a pessoa muda, não constante no repositório.

### 3. Desenhar

Você desenha **todas** as imagens, não só a capa. O redator deixa um bilhete —
`generate:` seguido do que a figura mostra — onde o corpo quer uma. Passe as
`sections` e esses bilhetes são preenchidos e devolvidos; omita e o corpo fica
com bilhete que ninguém lê.

```bash
t BLOG_POST_ILLUSTRATE "$(bun -e '
  const st = await Bun.file(process.env.RUN+"/blog-state.json").json();
  const d = await Bun.file(process.env.RUN+"/draft.json").json();
  const ph = await Bun.file(process.env.RUN+"/photos.json").json();
  const post = d.posts[0];
  console.log(JSON.stringify({
    requests: [{ id: "0", prompt: post.cover.prompt, alt: post.cover.alt }],
    sections: post.sections.map(s => ({ type: s.type, props: s.props })),
    productImages: ph.productImages, guidance: ph.guidance,
    companyName: st.brand?.companyName,
    fileConfigId: process.env.FILE_CONFIG_ID }));')" cover.json
```

`FILE_CONFIG_ID` sai do `FILE_CONFIG_LIST`.

A montagem usa `cover.json.sections` no lugar das do rascunho quando elas vêm.

**Passe `cover.prompt` verbatim.** A tool embrulha o prompt ela mesma
(`brief()`, `post-illustrate.ts:168`), acrescentando a atribuição e a regra de
não escrever letras na imagem. Re-embrulhar diz as duas coisas duas vezes.

Até **90s por imagem** (`IMAGE_TIMEOUT_MS`, `cover-image.ts:47`): a capa mais
até duas do corpo, sequenciais. Conte com uns quatro minutos no pior caso.

### 4. Ler o `outcome`

- `ok` — `images[0].url` é um endereço de CDN real.
- `no-bucket` — o `fileConfigId` não resolveu. Volte ao passo 1.
- `no-model` — a org não tem slot de modelo de imagem configurado. Pare e diga;
  é configuração.
- `failed` — o modelo recusou ou caiu. Pode repetir **esta coluna** sem refazer
  o rascunho; é por isso que ela é uma coluna separada.

`referenced` diz quantas fotos de produto condicionaram a geração — no máximo
3 respondem (`MAX_REFERENCE_PHOTOS`, `product-photo.ts:38`). `referenced: 0`
com fotos oferecidas quer dizer que nenhuma carregou: a capa saiu, mas sem
parecer com o produto.

### 5. Mover o card

Card para `ilustração`. Log com: quantos buckets, `outcome`, `referenced`,
`bodyImages`, e se a URL da capa veio.

Siga direto pra `blog-montagem`.
