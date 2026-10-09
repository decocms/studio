import type { releases as enReleases } from "../en/releases.ts";

export const releases = {
  "releases.title": "Versões",
  "releases.subtitle":
    "Todas as versões do seu site, da mais recente para a mais antiga. Você pode publicar uma anterior para trazê-la de volta.",
  "releases.loadFailed": "Não foi possível carregar suas versões.",
  "releases.publishedAgo": "Publicada {when}",
  "releases.nothingPublished": "Nada publicado ainda",
  "releases.published": "Publicada",
  "releases.actions": "Ações da versão",
  "releases.publishVersion": "Publicar esta versão",
  "releases.publishVersionTitle": "Publicar esta versão?",
  "releases.publishVersionBody":
    "Seu site passa a mostrar esta versão. A próxima publicação a substitui pelas suas alterações mais recentes.",
  "releases.schemaMismatchBody":
    "Esta versão foi feita para um design anterior do seu site. O site continua mostrando o que mostra agora até o design voltar a corresponder a esta versão. Publicar mesmo assim?",
  "releases.publishAnyway": "Publicar mesmo assim",
  "releases.versionLive": "Esta versão está no ar.",
  "releases.publishVersionFailed": "Não foi possível publicar esta versão.",
  "releases.siteUpdate": "Atualização do site",
  "releases.loadMore": "Carregar mais",
  "releases.cancel": "Cancelar",
} satisfies Record<keyof typeof enReleases, string>;
