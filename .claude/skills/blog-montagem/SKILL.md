---
name: blog-montagem
description: Fifth column of the content pipeline — assemble the draft into the block shape the CMS stores, suggest internal links, apply them, and commit the post as a draft on the Posts board. Ends at a human review checkpoint. Use after blog-ilustrador.
disable-model-invocation: true
---

# Coluna `montagem` — fechar e gravar

**Por que ela vem depois da ilustração.** A gravação precisa de `cover.url`,
que a ilustração produz, que precisa de `cover.prompt`, que o rascunho
produz. No navegador isso some dentro de uma closure; numa esteira vira
dependência que o board tem que mostrar. Esta é a coluna que a mostra.

## O que fazer

### 1. Montar, primeira passada

Monte o argumento uma vez e guarde: a segunda passada é o mesmo objeto mais
os links.

```bash
bun -e 'const c = await Bun.file(process.env.RUN+"/cover.json").json();
  const d = (await Bun.file(process.env.RUN+"/draft.json").json()).posts[0];
  await Bun.write(process.env.RUN+"/assemble-input.json", JSON.stringify({
    virtualMcpId: process.env.VMCP, branch: process.env.BRANCH,
    draft: { ...d, cover: { url: c.images[0]?.url ?? "", alt: d.cover.alt },
             sections: c.sections ?? d.sections },
    planning: { campaignKey: "<chave>", brief: "<a hipótese do card>" } }));'

t BLOG_POST_ASSEMBLE "$(cat $RUN/assemble-input.json)" assembled.json
```

É aqui que mora o trabalho que nenhuma prosa substitui: `type` de seção vira o
`__resolveType` **deste** site, `productIds` entram no slot de produto na forma
que **este** site armazena (quatro formas possíveis), o slug é desconflitado
contra os posts existentes, e a hipótese do card vira `planning.brief`.

Não grava nada. Leia `dropped` — são seções sem bloco correspondente no site.
Se for mais que zero, diga quais no card.

Guarde `postId`: a segunda passada precisa do mesmo.

### 2. Sugerir links

Só vale se o site já tem outros posts — `assembled.json` traz `posts`. Se vier
vazio, **pule** direto pro passo 4.

```bash
t BLOG_LINK_SUGGEST "$(bun -e '
  const a = await Bun.file(process.env.RUN+"/assembled.json").json();
  const g = await Bun.file(process.env.RUN+"/grounding.json").json();
  console.log(JSON.stringify({ virtualMcpId: process.env.VMCP,
    body: a.bodyText, posts: a.posts, count: 8,
    grounding: { report: g.report, outcome: g.outcome } }));')" links.json
```

> Divergência conhecida com o navegador, registre no card: o navegador faz um
> **segundo** embasamento com `purpose: "link"`. Aqui reusamos o de `post`.
> Não é paridade; é uma chamada a menos de propósito.

### 3. Montar de novo, com os links

```bash
t BLOG_POST_ASSEMBLE "$(bun -e '
  const i = await Bun.file(process.env.RUN+"/assemble-input.json").json();
  const a = await Bun.file(process.env.RUN+"/assembled.json").json();
  const l = await Bun.file(process.env.RUN+"/links.json").json();
  console.log(JSON.stringify({ ...i, postId: a.postId, links: l.suggestions }));')" post.json
```

Mesmo `postId`, mesma `draft`, agora com `links`. `applied` diz quantas
entraram — uma citação cujo trecho cruza uma tag inline é pulada em vez de
embrulhada, então `applied` menor que o sugerido é normal.

### 4. Gravar

```bash
t BLOG_POST_WRITE "$(bun -e '
  const p = await Bun.file(process.env.RUN+"/post.json").json();
  console.log(JSON.stringify({ virtualMcpId: process.env.VMCP,
    branch: process.env.BRANCH, postId: p.postId, post: p.post }));')" write.json
```

Devolve `{ key, version, branch }`. `version` é o commit. **Confira a branch**
antes de seguir.

Se vier `BlockConflictError` — alguém editou o mesmo bloco no meio —, releia e
regrave. A escrita serializa com o editor do navegador pela mesma
`decofileQueueKey`, então as duas não corrompem uma à outra; só uma precisa
repetir.

### 5. Mover o card e parar

Card para `revisão`, com `blog-manager/posts/<postId>`, o commit, e o log
completo.

**Checkpoint humano, e este é estrutural.** O bloco é gravado **sem
`__resolveType`**, então a loja não resolve o rascunho qualquer que seja o
`status` dele. Publicar é promover para `collections/blog/posts/<id>`, que é
`movePostToStatus` no navegador — não existe tool por trás, de propósito.

Diga ao usuário: o post está no board de Posts como **Aguardando revisão**, e
nada do que a esteira escreveu alcança um leitor sem alguém decidir.
