import type { releases as enReleases } from "../en/releases.ts";

export const releases = {
  "releases.title": "Versões",
  "releases.subtitle":
    "Todas as alterações mescladas na main, da mais recente para a mais antiga. Publicar também cria uma versão na CDN; Tornar atual faz a CDN servir qualquer versão.",
  "releases.loadFailed": "Não foi possível carregar as versões",
  "releases.currentOnCdn": "Atual na CDN:",
  "releases.madeCurrentAgo": "tornada atual {when}",
  "releases.nothingOnCdn": "Nada na CDN ainda",
  "releases.current": "Atual",
  "releases.actions": "Ações da versão",
  "releases.makeCurrent": "Tornar atual",
  "releases.makeCurrentTitle": "Tornar {sha} a versão atual?",
  "releases.makeCurrentBody":
    "A CDN passa a servir esta versão. O git não muda, e a próxima publicação torna a sua própria versão atual.",
  "releases.schemaMismatchBody":
    "Esta versão foi criada com um schema diferente do da main. Sites gerados a partir da main mantêm o conteúdo atual até os schemas voltarem a coincidir.",
  "releases.madeCurrent": "{sha} agora é a versão atual",
  "releases.loadMore": "Carregar mais",
  "releases.cancel": "Cancelar",
} satisfies Record<keyof typeof enReleases, string>;
