import type { releases as enReleases } from "../en/releases.ts";

export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Todas as releases do seu site, da mais recente para a mais antiga. Para trazer de volta o conteúdo de uma anterior, torne-a atual.",
  "releases.loadFailed": "Não foi possível carregar suas releases.",
  "releases.nothingPublished": "Nada publicado ainda",
  "releases.lastPublished": "Última publicação {when}.",
  "releases.latest": "Mais recente",
  "releases.actions": "Ações da release",
  "releases.preview": "Visualizar esta versão",
  "releases.reapply": "Tornar atual",
  "releases.reapplyTitle": "Tornar esta release atual?",
  "releases.reapplyBody":
    "Ao torná-la atual, publicamos uma nova release com o mesmo conteúdo de “{title}”. As alterações feitas desde então serão substituídas no seu site.",
  "releases.reapplyUndoHint":
    "A release marcada como Mais recente continua na lista: para voltar depois, torne-a atual de novo.",
  "releases.reapplyConfirm": "Tornar atual",
  "releases.reapplying": "Tornando atual…",
  "releases.reapplied":
    "Release tornada atual. Seu site vai mostrá-la em instantes.",
  "releases.reappliedUndoHint":
    "Se algo não ficar certo, torne atual de novo a release anterior para voltar.",
  "releases.reapplyFailed": "Não foi possível tornar esta release atual.",
  "releases.alreadyShown": "Seu site já tem o conteúdo desta release.",
  "releases.publishedMeanwhile":
    "Alguém publicou enquanto você tornava esta release atual, então nada mudou. Tente de novo.",
  "releases.reapplyOf": "Tornada atual: {title}",
  "releases.reapplyOfDate": "Tornada atual: release de {when}",
  "releases.sameContentAs": "Mesmo conteúdo da release de {when}",
  "releases.untitled": "Alterações publicadas",
  "releases.siteUpdate": "Atualização do site",
  "releases.loadMore": "Carregar mais",
  "releases.cancel": "Cancelar",
} satisfies Record<keyof typeof enReleases, string>;
