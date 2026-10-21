import type { releases as enReleases } from "../en/releases.ts";

export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Todas as releases do seu site, da mais recente para a mais antiga. Reaplique uma anterior para trazer o conteúdo dela de volta.",
  "releases.loadFailed": "Não foi possível carregar suas releases.",
  "releases.nothingPublished": "Nada publicado ainda",
  "releases.lastPublished": "Última publicação {when}.",
  "releases.latest": "Mais recente",
  "releases.actions": "Ações da release",
  "releases.preview": "Visualizar esta release",
  "releases.reapply": "Reaplicar release",
  "releases.reapplyTitle": "Reaplicar esta release?",
  "releases.reapplyBody":
    "Isso publica uma nova release com o mesmo conteúdo de “{title}”. As alterações feitas desde então serão substituídas no seu site.",
  "releases.reapplyUndoHint":
    "Se algo não ficar certo depois, reaplique a release que você tem agora para voltar.",
  "releases.reapplyConfirm": "Reaplicar",
  "releases.reapplying": "Reaplicando…",
  "releases.reapplied": "Reaplicada. Seu site vai mostrá-la em instantes.",
  "releases.reappliedUndoHint":
    "Se algo não ficar certo, reaplique a release anterior para voltar.",
  "releases.reapplyFailed": "Não foi possível reaplicar esta release.",
  "releases.alreadyShown": "Seu site já tem o conteúdo desta release.",
  "releases.publishedMeanwhile":
    "Alguém publicou enquanto você reaplicava, então nada mudou. Tente de novo.",
  "releases.reapplyOf": "Reaplicação: {title}",
  "releases.reapplyOfDate": "Reaplicação da release de {when}",
  "releases.sameContentAs": "Mesmo conteúdo da release de {when}",
  "releases.untitled": "Alterações publicadas",
  "releases.siteUpdate": "Atualização do site",
  "releases.loadMore": "Carregar mais",
  "releases.cancel": "Cancelar",
} satisfies Record<keyof typeof enReleases, string>;
