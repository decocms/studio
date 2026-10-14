import type { releases as enReleases } from "../en/releases.ts";

export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Todas as versões do seu site, da mais recente para a mais antiga. Reaplique uma anterior para trazer o conteúdo dela de volta.",
  "releases.loadFailed": "Não foi possível carregar suas releases.",
  "releases.nothingPublished": "Nada publicado ainda",
  "releases.lastPublished": "Última publicação {when}.",
  "releases.latest": "Mais recente",
  "releases.actions": "Ações da versão",
  "releases.reapply": "Reaplicar versão",
  "releases.reapplyTitle": "Reaplicar esta versão?",
  "releases.reapplyBody":
    "Isso publica uma nova versão com o mesmo conteúdo de “{title}”. As alterações feitas desde então serão substituídas no seu site.",
  "releases.reapplyUndoHint":
    "Se algo não ficar certo depois, reaplique a versão que você tem agora para voltar.",
  "releases.reapplyConfirm": "Reaplicar",
  "releases.reapplying": "Reaplicando…",
  "releases.reapplied": "Reaplicada. Seu site vai mostrá-la em instantes.",
  "releases.reappliedUndoHint":
    "Se algo não ficar certo, reaplique a versão anterior para voltar.",
  "releases.reapplyFailed": "Não foi possível reaplicar esta versão.",
  "releases.alreadyShown": "Seu site já tem o conteúdo desta versão.",
  "releases.publishedMeanwhile":
    "Alguém publicou enquanto você reaplicava, então nada mudou. Tente de novo.",
  "releases.reapplyOf": "Reaplicação: {title}",
  "releases.reapplyOfDate": "Reaplicação da versão de {when}",
  "releases.sameContentAs": "Mesmo conteúdo da versão de {when}",
  "releases.untitled": "Alterações publicadas",
  "releases.siteUpdate": "Atualização do site",
  "releases.loadMore": "Carregar mais",
  "releases.cancel": "Cancelar",
} satisfies Record<keyof typeof enReleases, string>;
