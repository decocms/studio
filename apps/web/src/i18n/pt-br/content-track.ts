import type { contentTrack as contentTrackEn } from "../en/content-track.ts";

export const contentTrack = {
  "contentTrack.title": "Conteúdo",
  "contentTrack.trackCode": "Código",
  "contentTrack.trackContent": "Conteúdo",
  "contentTrack.viewBlogposts": "Blogposts",
  "contentTrack.viewCampaigns": "Campanhas",
  "contentTrack.blogpostsEmptyTitle": "Nenhum blogpost ainda",
  "contentTrack.blogpostsEmptyDescription":
    "Comece um a partir de uma campanha: a redação traz uma hipótese dos dados da sua loja e escreve o post quando você aprovar.",
  "contentTrack.setup.eyebrow": "Esteira de conteúdo · ainda não configurada",
  "contentTrack.setup.title": "Ative a redação autônoma da sua marca",
  "contentTrack.setup.description":
    "O Studio aprende uma vez como a sua marca escreve. Depois traz ideias de post a partir dos dados da loja, escreve no seu próprio site e deixa cada uma para você revisar.",
  "contentTrack.setup.strategist": "Estrategista",
  "contentTrack.setup.strategistJob": "a aposta",
  "contentTrack.setup.researcher": "Pesquisador",
  "contentTrack.setup.researcherJob": "a evidência",
  "contentTrack.setup.writer": "Redator",
  "contentTrack.setup.writerJob": "o texto",
  "contentTrack.setup.creator": "Criador",
  "contentTrack.setup.creatorJob": "as imagens",
  "contentTrack.setup.loopContext": "Contexto",
  "contentTrack.setup.loopHypothesis": "Hipótese",
  "contentTrack.setup.loopExecute": "Execução",
  "contentTrack.setup.loopMonitor": "Monitor",
  "contentTrack.setup.missing":
    "O guia da sua marca ainda precisa de: {fields}.",
  "contentTrack.setup.activate": "Ativar redação",
} satisfies Record<keyof typeof contentTrackEn, string>;
