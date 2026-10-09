import type { siteEditor as siteEditorEn } from "../en/site-editor.ts";

export const siteEditor = {
  "siteEditor.details": "Detalhes",
  "siteEditor.tryAgain": "Tentar de novo",
  "siteEditor.publish.published": "Publicado",
  "siteEditor.save.failed":
    "Não foi possível salvar sua alteração. Tente de novo.",
  "siteEditor.save.conflict":
    "Não foi salvo: outra pessoa alterou isto ao mesmo tempo. Estamos carregando a versão dela, então refaça sua alteração.",
  "siteEditor.save.readOnly":
    "Não foi salvo: esta versão não pode ser editada.",
  "siteEditor.save.invalid":
    "Não foi salvo: alguns campos não estão preenchidos corretamente. Corrija e tente de novo.",
  "siteEditor.save.tooLarge":
    "Não foi salvo: este conteúdo é grande demais. Diminua o tamanho e tente de novo.",
} satisfies Record<keyof typeof siteEditorEn, string>;
