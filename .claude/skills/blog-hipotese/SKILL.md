---
name: blog-hipotese
description: Open a card on the content pipeline board — the hypothesis a post is written to test, and the run directory the rest of the pipeline fills. First column of the manual pipeline. Use when starting a new blog post run.
disable-model-invocation: true
---

# Coluna `hipótese` — abrir o card

A primeira coluna da esteira. Nenhuma chamada de rede: o que ela produz é a
razão do post existir, e o diretório onde as outras quatro vão escrever.

**Na automação real esta coluna é um gatilho** — uma data de campanha, um
movimento no Search Console, estoque parado. Gatilho é objeto do Studio com
agenda e token, não skill: nada dentro de uma skill acorda sozinho. Nesta
rodada **a pessoa é o gatilho**, e esta skill existe pra deixar essa
substituição visível em vez de escondida.

## O que fazer

### 1. Pedir a hipótese

Se o usuário não disse, pergunte. Uma hipótese é **o que você acredita e por
que**, não um título:

> Quem chega buscando "presente para X" no fim do ano quer curadoria, não
> catálogo. Um guia por perfil deve converter melhor que uma lista de produtos.

Ela não é decoração: vira `planning.brief` no post gravado
(`PlanningMeta`, `blog-data.ts:676`), então a mesma frase existe no board e
dentro do produto. É o que o Daniel pediu — não perder a origem do que foi
executado.

### 2. Descobrir o alvo

Precisa de três coisas. Pergunte ao usuário o que faltar:

- `orgSlug` — a org no Studio
- `virtualMcpId` — o projeto (`vir_…`); `COLLECTION_VIRTUAL_MCP_LIST` lista
- `branch` — em geral `main`

### 3. Criar o run

Próximo id livre em `.blog-pipeline/runs/` (`001`, `002`, …).

```bash
mkdir -p .blog-pipeline/runs/<cardId>
```

`run.json`:

```json
{
  "cardId": "<cardId>",
  "orgSlug": "<orgSlug>",
  "virtualMcpId": "vir_...",
  "branch": "main",
  "hipotese": "<a hipótese, em uma ou duas frases>",
  "origem": "<de onde ela veio: leitura do GSC, pedido do cliente, calendário>"
}
```

E `hipotese.md` com o texto longo, se houver mais que duas frases.

> O diretório do run é **ignorado pelo git** (`.gitignore`). Ele vai conter
> perfil de marca, URL da loja e ids de produto — nada disso entra em artefato
> compartilhado.

### 4. Abrir o card no board

Em `docs/blog-pipeline/board.md`: uma linha na tabela de cards com coluna
`hipótese`, e uma seção `### <cardId> — <título de trabalho>` com a hipótese e
a tabela de campos vazia.

O board é commitável, então **nada de nome de org, site, slug, URL ou pessoa
nele** (AGENTS.md). O título de trabalho é editorial, não o nome do cliente.

### 5. Parar

Diga qual é o card, onde está o run, e que a próxima coluna é
`blog-estrategista`. Não siga adiante — cada coluna é uma invocação.
