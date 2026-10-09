import type { siteEditor as siteEditorEn } from "../en/site-editor.ts";

export const siteEditor = {
  "siteEditor.details": "Detalhes",
  "siteEditor.tryAgain": "Tentar de novo",
  "siteEditor.publish.published": "Publicado",
  "siteEditor.save.failed":
    "Não foi possível salvar sua alteração. Tente de novo.",
  "siteEditor.save.conflict":
    "Não salvo: outra pessoa alterou isto ao mesmo tempo. Estamos carregando a versão dela, então refaça sua alteração.",
  "siteEditor.save.readOnly": "Não salvo: esta versão não pode ser editada.",
  "siteEditor.save.invalid": "Não salvo: {detail}. Corrija e tente de novo.",
  "siteEditor.save.tooLarge":
    "Não salvo: este conteúdo é grande demais. Diminua o tamanho e tente de novo.",
} satisfies Record<keyof typeof siteEditorEn, string>;
