import type { siteEditor as siteEditorEn } from "../en/site-editor.ts";

export const siteEditor = {
  "siteEditor.details": "Detalhes",
  "siteEditor.tryAgain": "Tentar de novo",
  "siteEditor.publish.published": "Publicado",
  "siteEditor.publish.changesLive": "Suas alterações estão no ar.",
  "siteEditor.publish.liveOn": "Suas alterações estão no ar em {host}.",
  "siteEditor.publish.nothingToPublish": "Nada para publicar",
  "siteEditor.publish.everythingLive": "Tudo já está no ar.",
  "siteEditor.publish.savedNotPublished": "Salvo, mas ainda não publicado",
  "siteEditor.publish.savedNotPublishedBody":
    "Suas alterações estão guardadas. Tente de novo para colocá-las no ar.",
  "siteEditor.publish.publishedMeanwhile":
    "Outra pessoa publicou enquanto você publicava, então nada mudou. Revise suas alterações e publique de novo.",
  "siteEditor.publish.failed":
    "Não foi possível publicar. Suas alterações estão salvas. Tente de novo em instantes.",
  "siteEditor.publish.defaultNote": "Alterações de {name}",
  "siteEditor.publish.defaultNoteAnonymous": "Atualização do site",
  "siteEditor.discard.failed": "Não foi possível descartar. Tente de novo.",
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
