---
name: blog-estrategista
description: Second column of the content pipeline — read the brand state, pick the campaign and format, read the blocks the site renders, and ground the brief against the store's own systems. Stops at a human checkpoint. Use after blog-hipotese.
disable-model-invocation: true
---

# Coluna `estratégia` — decidir o que escrever

Na automação real esta coluna é o **Estrategista**
(`apps/api/src/file-storage/project-agents.ts`), com belt
`BLOG_SITE_GROUND, BLOG_SITE_CATALOGUE, BLOG_CONTEXT_EXTRACT,
BLOG_FORMAT_SUGGEST, BLOG_CAMPAIGN_SUGGEST, BLOG_SITE_BLOCKS, BLOG_STATE_GET,
BLOG_STATE_SET`.

É a coluna pesada: ela decide **o que** se escreve e **com que blocos**.

## Transporte

Tudo é `curl` no Bash. Não há aba, não há dreno, e nenhuma resposta grande
passa pelo seu contexto.

```bash
export STUDIO_API_KEY=...          # Configurações → Chaves de API
export STUDIO=http://localhost:3000
export ORG=<slug>  VMCP=vir_...  BRANCH=<branch>  RUN=.blog-pipeline/runs/001

t() {  # t <TOOL> <json> <arquivo-de-saida>
  curl -sS -X POST "$STUDIO/api/$ORG/tools/$1" \
    -H "Authorization: Bearer $STUDIO_API_KEY" \
    -H 'content-type: application/json' \
    -d "$2" -o "$RUN/$3" -w '%{http_code}\n'
}
```

`curl` espera os 75s do embasamento e os 90s por imagem sem reclamar.

Allowlist da chave: `BLOG_STATE_GET`, `BLOG_STATE_SET`, `BLOG_SITE_BLOCKS`,
`BLOG_SITE_GROUND`, `BLOG_SITE_CATALOGUE`, `BLOG_POST_DRAFT`,
`BLOG_POST_ILLUSTRATE`, `BLOG_POST_ASSEMBLE`, `BLOG_LINK_SUGGEST`,
`BLOG_POST_WRITE`, `FILE_CONFIG_LIST`.

**`branch` importa.** Toda tool que lê ou grava o site cai na branch da thread
quando você omite, e recusa quando não há nenhuma. Nunca aponte pra default do
repositório: ela é produção.

## O que fazer

### 1. Ler o estado

```bash
mkdir -p "$RUN"
t BLOG_STATE_GET "{\"virtualMcpId\":\"$VMCP\"}" blog-state.json

bun -e 'const s=await Bun.file(process.env.RUN+"/blog-state.json").json();
  console.log("campanhas:", s.campaigns.map(c=>c.data.campaignName).join(" | "));
  console.log("formatos:", (s.formats?.formats??[]).map(f=>f.name).join(" | "));'
```

Escolha a campanha e o formato. **Diga qual escolheu e por quê** — é o que o
checkpoint vai conferir.

Se não houver campanha aberta, escreva uma à mão. **Não chame
`BLOG_CAMPAIGN_SUGGEST`** — leva ~122s e estoura o limite de ~100s do edge
quando chamada direto.

### 2. Ler os blocos do site

```bash
t BLOG_SITE_BLOCKS "$(bun -e '
  const s = await Bun.file(process.env.RUN+"/blog-state.json").json();
  const f = (s.formats?.formats ?? [])[0];
  console.log(JSON.stringify({ virtualMcpId: process.env.VMCP,
    branch: process.env.BRANCH, format: { name: f.name, value: f.value } }));')" blocks.json
```

Volta `blocks`, `categories` e `authors` — os três de uma leitura só do
decofile. É o argumento que `BLOG_POST_DRAFT` exige e que ele não inventa.

Se recusar com *"no blocks a post can be built from"*, o site não tem
`meta.gen.json` commitado ou não tem o app de blog. É problema do site, não da
esteira.

### 3. Embasar

```bash
t BLOG_SITE_GROUND "{\"virtualMcpId\":\"$VMCP\",\"purpose\":\"post\",\"focus\":\"<campanha>: <nota do gatilho>\",\"language\":\"pt-BR\"}" grounding.json
```

Teto duro de **75s** (`GROUNDING_TIMEOUT_MS`, `site-ground.ts:41`).

`outcome` pode voltar `no-site`, `no-tools`, `timeout` ou `failed`. **Não é
falha da coluna** — o navegador trata embasamento ruim como *mais magro, não
ausente* (`use-generate-post.ts:265`). Registre o `outcome` no card e siga.

### 4. Mover o card e parar

Card para `estratégia`. No log: quantas campanhas e formatos o estado tinha,
quais foram escolhidos, quantos blocos vieram e quais, e o `outcome` do
embasamento.

**Checkpoint humano.** Pare e pergunte: *esta campanha e este formato são os
certos pra esta hipótese?* Tudo depois custa dinheiro e uns quatro minutos;
este é o único ponto onde uma resposta errada é barata de corrigir.
