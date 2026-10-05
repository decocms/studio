import type { decoServe as decoServeEn } from "../en/deco-serve.ts";

export const decoServe = {
  "decoServe.chip.disconnect": "Desconectar",
  "decoServe.chip.label": "Servidor local",
  "decoServe.chip.tooltip":
    "Editando os arquivos da sua máquina pelo deco serve. Nada é commitado: revise as mudanças e faça o commit você mesmo.",
  "decoServe.connect.invalidLinkDescription":
    "Rode o deco serve e abra o link do editor do site que ele mostra. Depois disso, esta página se reconecta a ele sozinha.",
  "decoServe.connect.invalidLinkTitle":
    "Este link do editor de sites está incompleto",
  "decoServe.connect.reaching": "Conectando a {endpoint}…",
  "decoServe.connect.retry": "Tentar novamente",
  "decoServe.status.unreachable":
    "O servidor local não está respondendo. Inicie-o com npx @decocms/blocks serve e permita que este site acesse sua máquina se o Chrome pedir.",
  "decoServe.status.waiting": "Aguardando o deco serve em {host}…",
  "decoServe.version.v7":
    "Blocks v7: o Studio lê e grava este site pelo app em execução.",
  "decoServe.version.v8":
    "Blocks v8: o Studio edita o conteúdo deste site pelo protocolo de conteúdo, sem rodar o código dele.",
} satisfies Record<keyof typeof decoServeEn, string>;
