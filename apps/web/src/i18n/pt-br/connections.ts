import type { connections as connectionsEn } from "../en/connections.ts";

export const connections = {
  "connections.connectionCard.noDescription": "Sem descrição",
  "connections.createConnectionDialog.argumentsLabel": "Argumentos",
  "connections.createConnectionDialog.argumentsPlaceholder":
    "arg1 arg2 --flag value",
  "connections.createConnectionDialog.cancelButton": "Cancelar",
  "connections.createConnectionDialog.closeButton": "Fechar",
  "connections.createConnectionDialog.commandLabel": "Comando *",
  "connections.createConnectionDialog.commandPlaceholder":
    "node, bun, python...",
  "connections.createConnectionDialog.createButton": "Criar Conexão",
  "connections.createConnectionDialog.customCommandType":
    "Comando Personalizado",
  "connections.createConnectionDialog.description":
    "Crie uma conexão personalizada em sua organização. Preencha os detalhes abaixo.",
  "connections.createConnectionDialog.descriptionLabel": "Descrição",
  "connections.createConnectionDialog.descriptionPlaceholder":
    "Uma breve descrição desta conexão",
  "connections.createConnectionDialog.environmentVariablesLabel":
    "Variáveis de Ambiente",
  "connections.createConnectionDialog.failedToCreateConnection":
    "Falha ao criar conexão",
  "connections.createConnectionDialog.httpType": "HTTP",
  "connections.createConnectionDialog.nameLabel": "Nome *",
  "connections.createConnectionDialog.namePlaceholder": "Minha Conexão",
  "connections.createConnectionDialog.npmPackageLabel": "Pacote NPM *",
  "connections.createConnectionDialog.npmPackagePlaceholder":
    "@perplexity-ai/mcp-server",
  "connections.createConnectionDialog.npxPackageType": "Pacote NPX",
  "connections.createConnectionDialog.openGitHubPatSettings":
    "Abrir configurações de PAT do GitHub",
  "connections.createConnectionDialog.saving": "Salvando...",
  "connections.createConnectionDialog.sseType": "SSE",
  "connections.createConnectionDialog.title": "Criar Conexão",
  "connections.createConnectionDialog.tokenLabelDefault": "Token (opcional)",
  "connections.createConnectionDialog.tokenPlaceholderDefault":
    "Token de Bearer ou chave de API",
  "connections.createConnectionDialog.typeLabel": "Tipo *",
  "connections.createConnectionDialog.urlLabel": "URL *",
  "connections.createConnectionDialog.urlPlaceholder":
    "https://example.com/mcp",
  "connections.createConnectionDialog.websocketType": "Websocket",
  "connections.createConnectionDialog.workingDirectoryDescription":
    "Diretório onde o comando será executado",
  "connections.createConnectionDialog.workingDirectoryLabel":
    "Diretório de Trabalho",
  "connections.createConnectionDialog.workingDirectoryPlaceholder":
    "/path/to/project (opcional)",
  "connections.sandboxSignIn.callbackLabel": "Endereço de redirecionamento",
  "connections.sandboxSignIn.description":
    "Este servidor só aceita login pelo Claude Code, então o Studio faz o login pelo Claude Code em um sandbox temporário.",
  "connections.sandboxSignIn.finish": "Concluir",
  "connections.sandboxSignIn.openSignIn": "Abrir página de login",
  "connections.sandboxSignIn.pasteHint":
    "Depois de aprovar o acesso, seu navegador mostra uma página que não pode ser acessada. Copie o endereço completo dessa página e cole aqui.",
  "connections.sandboxSignIn.starting": "Iniciando um sandbox…",
  "connections.sandboxSignIn.title": "Entrar",
} satisfies Record<keyof typeof connectionsEn, string>;
