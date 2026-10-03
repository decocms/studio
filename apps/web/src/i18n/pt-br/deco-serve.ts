import type { decoServe as decoServeEn } from "../en/deco-serve.ts";

export const decoServe = {
  "decoServe.chip.disconnect": "Desconectar",
  "decoServe.chip.label": "Servidor local",
  "decoServe.chip.tooltip":
    "Editando os arquivos da sua máquina pelo deco serve. Nada é commitado: revise as mudanças e faça o commit você mesmo.",
  "decoServe.connect.invalidLinkDescription":
    "Rode o deco serve e abra o link do editor do site que ele mostra.",
  "decoServe.connect.invalidLinkTitle": "Este link de conexão está incompleto",
  "decoServe.connect.noProjects":
    "Esta organização ainda não tem projetos. Importe primeiro o repositório do site.",
  "decoServe.connect.notEnabledDescription":
    "A edição por servidor local não está habilitada para esta organização.",
  "decoServe.connect.notEnabledTitle": "Indisponível",
  "decoServe.connect.pickDescription":
    "Escolha o projeto de {root}, servido em {endpoint}.",
  "decoServe.connect.pickTitle": "Conecte seu servidor local",
  "decoServe.connect.reaching": "Conectando a {endpoint}…",
  "decoServe.connect.retry": "Tentar novamente",
  "decoServe.status.unauthorized":
    "O servidor local reiniciou com um novo token. Abra o link que o deco serve mostrou para reconectar.",
  "decoServe.status.unreachable":
    "O servidor local não está respondendo. Inicie-o com npx @decocms/blocks serve e permita que este site acesse sua máquina se o Chrome pedir.",
} satisfies Record<keyof typeof decoServeEn, string>;
