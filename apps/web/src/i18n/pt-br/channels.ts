import type { channels as channelsEn } from "../en/channels.ts";

export const channels = {
  "channels.nav": "Canais",
  "channels.unavailableTitle": "Canais não estão ativados",
  "channels.unavailableDescription":
    "Canais não estão ativados para esta organização.",
  "channels.connect": "Conectar um canal",
  "channels.emptyTitle": "Nenhum canal conectado",
  "channels.emptyDescription":
    "Conecte um número de WhatsApp, um bot do Discord ou outra conta para que as conversas apareçam aqui.",
  "channels.errorTitle": "Não foi possível carregar os canais",
  "channels.retry": "Tentar de novo",
  "channels.lastEvent": "Último evento {time}",
  "channels.neverEvent": "Nenhum evento ainda",
  "channels.rowMenu": "Ações",
  "channels.rotateToken": "Trocar token",
  "channels.delete": "Excluir",
  "channels.cancel": "Cancelar",
  "channels.form.title": "Conectar um canal",
  "channels.form.description":
    "O worker dele envia as conversas ao Studio com o token que você recebe em seguida.",
  "channels.form.source": "Origem",
  "channels.form.externalId": "Id da conta",
  "channels.form.externalIdHint":
    "A conta na origem: um número de telefone, o id de um bot ou de um workspace.",
  "channels.form.name": "Nome (opcional)",
  "channels.form.submit": "Conectar",
  "channels.form.submitting": "Conectando…",
  "channels.token.title": "Token de ingestão",
  "channels.token.description":
    "Copie agora para o worker do canal. Você não vai vê-lo de novo: fechar descarta o token.",
  "channels.token.copy": "Copiar token",
  "channels.token.copied": "Token copiado",
  "channels.token.done": "Concluir",
  "channels.rotate.title": "Trocar o token de {name}?",
  "channels.rotate.description":
    "O token atual para de funcionar na hora. O worker precisa do novo para continuar enviando.",
  "channels.delete.title": "Excluir {name}?",
  "channels.delete.description":
    "Tudo o que foi indexado dele (conversas, pessoas e mensagens) é excluído, e o token para de funcionar.",
  "channels.deleted": "Canal excluído",
  "channels.searchConversations": "Buscar conversas",
  "channels.noConversations": "Nenhuma conversa ainda",
  "channels.noConversationsMatch": 'Nenhuma conversa com "{query}"',
  "channels.loadMore": "Carregar mais",
  "channels.loadOlder": "Carregar anteriores",
  "channels.noMessages": "Nenhuma mensagem ainda",
  "channels.messageDeleted": "Mensagem apagada",
  "channels.attachmentsOne": "1 anexo",
  "channels.attachments": "{count} anexos",
  "channels.unknownAuthor": "Desconhecido",
} satisfies Record<keyof typeof channelsEn, string>;
