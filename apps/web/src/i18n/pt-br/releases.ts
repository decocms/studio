import type { releases as enReleases } from "../en/releases.ts";

export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Todas as releases do seu site, da mais recente para a mais antiga. Você pode colocar uma anterior no ar de novo.",
  "releases.loadFailed": "Não foi possível carregar suas releases.",
  "releases.wentLiveAgo": "Entrou no ar {when}",
  "releases.nothingLive": "Nada no ar ainda",
  "releases.live": "No ar",
  "releases.actions": "Ações da release",
  "releases.goLive": "Colocar no ar",
  "releases.goLiveTitle": "Colocar esta release no ar?",
  "releases.goLiveBody":
    "Seu site passa a mostrar esta release. A próxima publicação a substitui pelas suas alterações mais recentes.",
  "releases.schemaMismatchBody":
    "Esta release foi feita para um design anterior do seu site. O site continua mostrando o que mostra agora até o design voltar a corresponder a esta release. Colocar no ar mesmo assim?",
  "releases.goLiveAnyway": "Colocar no ar mesmo assim",
  "releases.goingLive": "Colocando no ar…",
  "releases.versionLive": "Esta release está no ar.",
  "releases.goLiveFailed": "Não foi possível colocar esta release no ar.",
  "releases.siteUpdate": "Atualização do site",
  "releases.loadMore": "Carregar mais",
  "releases.cancel": "Cancelar",
} satisfies Record<keyof typeof enReleases, string>;
