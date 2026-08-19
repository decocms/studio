import type { chooseEditor as enChooseEditor } from "../en/choose-editor.ts";

export const chooseEditor = {
  "chooseEditor.resolving": "Abrindo o editor…",
  "chooseEditor.chooser.title": "Escolha um projeto para editar",
  "chooseEditor.chooser.subtitle":
    "Este site está vinculado a mais de um projeto. Escolha qual abrir.",
  "chooseEditor.chooser.openAriaLabel": "Abrir {title}",
  "chooseEditor.notFound.title": "Não encontramos este site",
  "chooseEditor.notFound.description":
    "Esta loja não está vinculada a um projeto que você possa editar. Importe-a no Studio para começar a editar.",
  "chooseEditor.error.title": "Algo deu errado",
  "chooseEditor.error.description":
    "Não conseguimos abrir o editor. Tente novamente.",
  "chooseEditor.retry": "Tentar novamente",
  "chooseEditor.backToStudio": "Ir para o Studio",
} satisfies Record<keyof typeof enChooseEditor, string>;
