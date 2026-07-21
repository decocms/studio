import type { connections as connectionsEn } from "../en/connections.ts";

export const connections = {
  "connections.createConnectionDialog.argumentsLabel": "Argumentos",
  "connections.createConnectionDialog.argumentsPlaceholder":
    "arg1 arg2 --flag value",
  "connections.createConnectionDialog.cancelButton": "Cancelar",
  "connections.createConnectionDialog.commandLabel": "Comando *",
  "connections.createConnectionDialog.commandPlaceholder":
    "node, bun, python...",
  "connections.createConnectionDialog.createButton": "Criar Conex\u00e3o",
  "connections.createConnectionDialog.customCommandType":
    "Comando Personalizado",
  "connections.createConnectionDialog.description":
    "Crie uma conex\u00e3o personalizada em sua organiza\u00e7\u00e3o. Preencha os detalhes abaixo.",
  "connections.createConnectionDialog.descriptionLabel": "Descri\u00e7\u00e3o",
  "connections.createConnectionDialog.descriptionPlaceholder":
    "Uma breve descri\u00e7\u00e3o desta conex\u00e3o",
  "connections.createConnectionDialog.environmentVariablesLabel":
    "Vari\u00e1veis de Ambiente",
  "connections.createConnectionDialog.failedToCreateConnection":
    "Falha ao criar conex\u00e3o",
  "connections.createConnectionDialog.httpType": "HTTP",
  "connections.createConnectionDialog.nameLabel": "Nome *",
  "connections.createConnectionDialog.namePlaceholder": "Minha Conex\u00e3o",
  "connections.createConnectionDialog.npmPackageLabel": "Pacote NPM *",
  "connections.createConnectionDialog.npmPackagePlaceholder":
    "@perplexity-ai/mcp-server",
  "connections.createConnectionDialog.npxPackageType": "Pacote NPX",
  "connections.createConnectionDialog.openGitHubPatSettings":
    "Abrir configura\u00e7\u00f5es de PAT do GitHub",
  "connections.createConnectionDialog.saving": "Salvando...",
  "connections.createConnectionDialog.sseType": "SSE",
  "connections.createConnectionDialog.title": "Criar Conex\u00e3o",
  "connections.createConnectionDialog.tokenLabelDefault": "Token (opcional)",
  "connections.createConnectionDialog.tokenPlaceholderDefault":
    "Token de Bearer ou chave de API",
  "connections.createConnectionDialog.typeLabel": "Tipo *",
  "connections.createConnectionDialog.urlLabel": "URL *",
  "connections.createConnectionDialog.urlPlaceholder":
    "https://example.com/mcp",
  "connections.createConnectionDialog.websocketType": "Websocket",
  "connections.createConnectionDialog.workingDirectoryDescription":
    "Diret\u00f3rio onde o comando ser\u00e1 executado",
  "connections.createConnectionDialog.workingDirectoryLabel":
    "Diret\u00f3rio de Trabalho",
  "connections.createConnectionDialog.workingDirectoryPlaceholder":
    "/path/to/project (opcional)",
} satisfies Record<keyof typeof connectionsEn, string>;
