import type { releases as enReleases } from "../en/releases.ts";

export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Todas as releases do seu site, da mais recente para a mais antiga. Você pode publicar uma anterior para trazê-la de volta.",
  "releases.loadFailed": "Não foi possível carregar suas releases.",
  "releases.publishedAgo": "Publicada {when}",
  "releases.nothingPublished": "Nada publicado ainda",
  "releases.published": "Publicada",
  "releases.actions": "Ações da release",
  "releases.publishVersion": "Publicar esta release",
  "releases.publishVersionTitle": "Publicar esta release?",
  "releases.publishVersionBody":
    "Seu site passa a mostrar esta release. A próxima publicação a substitui pelas suas alterações mais recentes.",
  "releases.schemaMismatchBody":
    "Esta release foi feita para um design anterior do seu site. O site continua mostrando o que mostra agora até o design voltar a corresponder a esta release. Publicar mesmo assim?",
  "releases.publishAnyway": "Publicar mesmo assim",
  "releases.versionLive": "Esta release está no ar.",
  "releases.publishVersionFailed": "Não foi possível publicar esta release.",
  "releases.siteUpdate": "Atualização do site",
  "releases.loadMore": "Carregar mais",
  "releases.cancel": "Cancelar",
} satisfies Record<keyof typeof enReleases, string>;
