import type { releases as enReleases } from "../en/releases.ts";

export const releases = {
  "releases.title": "Versões",
  "releases.subtitle":
    "O que o seu site serve, e todas as versões da main. Reverter é temporário: a próxima publicação ou ressincronização coloca a main no ar de novo.",
  "releases.loadFailed": "Não foi possível carregar as versões",
  "releases.serving": "No ar nos sites em execução",
  "releases.nothingPublished": "Nada foi publicado pelo CMS ainda.",
  "releases.publishedAgo": "publicada {when}",
  "releases.rolledBackHint":
    "Revertido: a main está em {head}. A próxima publicação ou ressincronização substitui esta versão.",
  "releases.state.live": "No ar",
  "releases.state.rolledBack": "Revertido",
  "releases.state.pending": "Não publicado",
  "releases.current": "Atual",
  "releases.notPublished": "Não publicada pelo CMS",
  "releases.actions": "Ações da versão",
  "releases.makeCurrent": "Tornar atual",
  "releases.makeCurrentTitle": "Tornar {sha} a versão atual?",
  "releases.makeCurrentBody":
    "Os sites em execução passam para esta versão em alguns minutos. O git não muda, e a próxima publicação ou ressincronização substitui esta escolha.",
  "releases.schemaMismatchBody":
    "Esta versão foi publicada com um schema diferente do da main. Sites gerados a partir da main mantêm o conteúdo atual até os schemas voltarem a coincidir.",
  "releases.madeCurrent": "{sha} agora é a versão atual",
  "releases.resync": "Ressincronizar",
  "releases.resynced": "A main está no ar de novo",
  "releases.resyncPending":
    "A main mudou durante a ressincronização; nada mudou. Tente novamente.",
  "releases.resyncConfirmTitle": "Substituir a reversão?",
  "releases.resyncConfirmBody":
    "O site está revertido para uma versão anterior. Ressincronizar coloca no ar a versão mais recente da main.",
  "releases.loadMore": "Carregar mais",
  "releases.cancel": "Cancelar",
} satisfies Record<keyof typeof enReleases, string>;
