import type { releases as enReleases } from "../en/releases.ts";

export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Todas as releases do seu site, da mais recente para a mais antiga. Republique uma anterior para trazer o conteúdo dela de volta.",
  "releases.loadFailed": "Não foi possível carregar suas releases.",
  "releases.nothingLive": "Nada no ar ainda",
  "releases.checkedWithSite": "Seu site confirmou o que está mostrando {when}.",
  "releases.outsideStudio":
    "Seu site mostra uma versão que não está nesta lista.",
  "releases.lastPublished": "Última publicação {when}.",
  "releases.liveHint":
    "Com base na sua última publicação: seu site ainda não informou o que está mostrando.",
  "releases.live": "No ar",
  "releases.goingLive": "Entrando no ar…",
  "releases.goingLiveHint": "Seu site vai mostrá-la em um ou dois minutos.",
  "releases.published": "Publicada",
  "releases.notReportedHint":
    "Publicada. Seu site ainda não confirmou que a está mostrando.",
  "releases.actions": "Ações da release",
  "releases.republish": "Republicar",
  "releases.republishTitle": "Republicar esta release?",
  "releases.republishBody":
    "Isso publica uma nova release com o mesmo conteúdo de “{title}”. As alterações feitas desde então serão substituídas no seu site.",
  "releases.schemaMismatchBody":
    "Esta release foi feita para um design anterior do seu site. Algumas partes podem ficar diferentes ou não aparecer depois de republicá-la.",
  "releases.republishAnyway": "Republicar mesmo assim",
  "releases.republishing": "Republicando…",
  "releases.republished": "Republicada. Seu site vai mostrá-la em instantes.",
  "releases.republishFailed": "Não foi possível republicar esta release.",
  "releases.alreadyShown": "Seu site já mostra o conteúdo desta release.",
  "releases.publishedMeanwhile":
    "Alguém publicou enquanto você republicava, então nada mudou. Tente de novo.",
  "releases.republishOf": "Republicação: {title}",
  "releases.republishOfDate": "Republicação da release de {when}",
  "releases.sameContentAs": "Mesmo conteúdo da release de {when}",
  "releases.untitled": "Alterações publicadas",
  "releases.siteUpdate": "Atualização do site",
  "releases.loadMore": "Carregar mais",
  "releases.cancel": "Cancelar",
} satisfies Record<keyof typeof enReleases, string>;
