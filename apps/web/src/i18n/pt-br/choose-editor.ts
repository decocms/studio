import type { chooseEditor as enChooseEditor } from "../en/choose-editor.ts";

export const chooseEditor = {
  "chooseEditor.resolving": "Abrindo o editor…",
  "chooseEditor.chooser.title": "Escolha onde editar este site",
  "chooseEditor.chooser.subtitle":
    "Este site está em mais de um dos seus workspaces. Escolha onde abrir.",
  "chooseEditor.chooser.openAriaLabel": "Abrir {title} em {org}",
  "chooseEditor.notFound.title": "Não encontramos este site",
  "chooseEditor.notFound.description":
    "Este site não está em nenhum workspace que você tenha acesso. Importe-o no Studio para começar a editar.",
  "chooseEditor.error.title": "Algo deu errado",
  "chooseEditor.error.description":
    "Não conseguimos abrir o editor. Tente novamente.",
  "chooseEditor.retry": "Tentar novamente",
  "chooseEditor.backToStudio": "Ir para o Studio",
} satisfies Record<keyof typeof enChooseEditor, string>;
