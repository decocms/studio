import type { siteEditor as siteEditorEn } from "../en/site-editor.ts";

export const siteEditor = {
  "siteEditor.details": "Detalhes",
  "siteEditor.tryAgain": "Tentar de novo",
  "siteEditor.publish.published":
    "Publicado. Seu site vai mostrar em instantes.",
  "siteEditor.publish.publishedOn":
    "Publicado. {host} vai mostrar em instantes.",
  "siteEditor.publish.nothingToPublish": "Nada para publicar",
  "siteEditor.publish.everythingPublished": "Tudo já está publicado.",
  "siteEditor.publish.savedNotPublished": "Salvo, mas ainda não publicado",
  "siteEditor.publish.savedNotPublishedBody":
    "Suas alterações estão salvas. Tente de novo para publicá-las.",
  "siteEditor.publish.publishedMeanwhile":
    "Outra pessoa publicou enquanto você publicava, então nada mudou. Revise suas alterações e publique de novo.",
  "siteEditor.publish.changedMeanwhile":
    "Suas alterações mudaram enquanto você revisava. Feche e abra de novo para ver o que será publicado.",
  "siteEditor.publish.failed":
    "Não foi possível publicar. Suas alterações estão salvas. Tente de novo em instantes.",
  "siteEditor.publish.defaultNote": "Alterações de {name}",
  "siteEditor.publish.defaultNoteAnonymous": "Atualização do site",
  "siteEditor.discard.failed": "Não foi possível descartar. Tente de novo.",
  "siteEditor.discard.changedMeanwhile":
    "Isto mudou enquanto você olhava, então nada foi descartado. A lista já está atualizada.",
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
  "siteEditor.retrying.github":
    "Não foi possível acessar o GitHub agora. Tentando de novo…",
  "siteEditor.retrying.sandbox":
    "Não foi possível acessar o sandbox agora. Tentando de novo…",
  "siteEditor.siteNotOwned.title": "Este site é editado em outro projeto",
  "siteEditor.siteNotOwned.body":
    "Outro projeto no Studio foi configurado com este site primeiro, então o conteúdo dele é editado e publicado lá. Abra esse projeto para mudar o conteúdo do site. Aqui você ainda pode conversar e trabalhar no código do site.",
  "siteEditor.siteNotOwned.openProjects": "Ver projetos",
} satisfies Record<keyof typeof siteEditorEn, string>;
