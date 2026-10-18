import type { forum as en } from "../en/forum";

export const forum = {
  "forum.newTopicIn": "Novo tópico em {channel}",
  "forum.backToThreads": "Todos os tópicos",
  "forum.threadsView": "Tópicos",
  "forum.channel": "Canal",
  "forum.commands": "Comandos",
  "forum.sort.following": "Seguindo",
  "forum.emptyFollowing":
    "Tópicos que você postou, respondeu ou segue aparecem aqui.",
  "forum.scoreTitle": "Deco Score · {domain}",
  "forum.scoreCommand": "Pedir uma Deco Score ao deco",
  "forum.scoreHint":
    "O deco vai escanear {domain} e responder no tópico com a nota e o que corrigir primeiro.",
  "forum.scoreNeedsDomain":
    "Digite um domínio depois de /score, como /score loja.com.br",
  "forum.scorePost": "Pedir score",
  "forum.agentName": "deco",
  "forum.agentScoring": "O deco está avaliando este site…",
  "forum.kind": "Tipo",
  "forum.newTopic": "Novo tópico",
  "forum.sort.hot": "Em alta",
  "forum.sort.new": "Recentes",
  "forum.sort.top": "Mais votados",
  "forum.sort.unanswered": "Sem resposta",
  "forum.loading": "Carregando…",
  "forum.empty": "Nenhum tópico ainda. Comece o primeiro.",
  "forum.emptyUnanswered": "Todo tópico aqui já tem resposta.",
  "forum.lastActivity": "Última atividade",
  "forum.vote": "Votar",
  "forum.topicNotFound": "Este tópico não existe ou foi removido.",
  "forum.replies": "Respostas ({count})",
  "forum.replyFailed": "Não foi possível publicar sua resposta",
  "forum.createFailed": "Não foi possível criar o tópico",
  "forum.titlePlaceholder":
    "Título, ou um comando: /bounty, /score loja.com.br",
  "forum.bodyPlaceholder": "Escreva seu post. Aceita Markdown.",
  "forum.cancel": "Cancelar",
  "forum.post": "Publicar tópico",
  "forum.status.todo": "Planejado",
  "forum.status.inProgress": "Em andamento",
  "forum.status.inReview": "Em revisão",
  "forum.status.done": "Concluído",
  "forum.template.proposal":
    "**Problema**\n\n\n**Proposta**\n\n\n**Por que agora**\n",
  "forum.template.question":
    "**O que estou tentando fazer**\n\n\n**O que já tentei**\n",
  "forum.template.role":
    "**Empresa**\n\n**Stack**\n\n**Remoto / presencial**\n\n**Remuneração**\n\n**O que você vai fazer**\n",
  "forum.template.bounty":
    "**Escopo**\n\n\n**Critérios de aceite**\n- \n\n**Recompensa:**  · **Prazo:** \n",
  "forum.template.gig":
    "**O que precisa ser feito**\n\n**Orçamento**\n\n**Prazo**\n",
  "forum.template.profile":
    "**Resumo:** \n- **Skills:** \n- **Valor:** \n- **Disponibilidade:** \n- **Links:** \n",
  "forum.template.help":
    "**O que aconteceu**\n\n\n**O que eu esperava**\n\n\n**Como reproduzir**\n",
} satisfies Record<keyof typeof en, string>;
