import type { discover as en } from "../en/discover";

export const discover = {
  "discover.title": "Descobrir",
  "discover.subtitle":
    "O que este workspace ainda não tem — o que falta configurar, o que dá para ativar e o que dá para adicionar.",

  "discover.setup.title": "Terminar a configuração",
  "discover.setup.description":
    "Alguns passos liberam a maior parte do que o Studio faz por você.",
  "discover.setup.allDone": "Tudo pronto por aqui.",
  "discover.setup.connectTitle": "Conecte uma fonte de dados",
  "discover.setup.connectBody":
    "Analytics, sua loja, um banco de dados — qualquer coisa que o Studio deva conseguir ler.",
  "discover.setup.connectAction": "Explorar",
  "discover.setup.githubTitle": "Conecte o GitHub",
  "discover.setup.githubBody":
    "Necessário para previews, código, pull requests e sessões de código.",
  "discover.setup.githubAction": "Conectar",
  "discover.setup.projectTitle": "Crie um projeto",
  "discover.setup.projectBody":
    "Um projeto guarda uma base de código — seu preview, seu conteúdo e seus arquivos.",
  "discover.setup.projectAction": "Criar",
  "discover.setup.inviteTitle": "Convide alguém do time",
  "discover.setup.inviteBody":
    "Chats, tarefas e arquivos são compartilhados por todo o workspace.",
  "discover.setup.inviteAction": "Convidar",

  "discover.capabilities.title": "Ativar",
  "discover.capabilities.description":
    "Aparecem automaticamente em um projeto assim que o necessário estiver no lugar.",
  "discover.capabilities.ready": "Pronto para usar",
  "discover.capabilities.previewTitle": "Preview",
  "discover.capabilities.previewRequirement":
    "Precisa de um projeto com um repositório vinculado.",
  "discover.capabilities.gitTitle": "Pull requests",
  "discover.capabilities.gitRequirement":
    "Precisa de uma conta do GitHub conectada e de um projeto apontando para um repositório.",
  "discover.capabilities.contentTitle": "Edição de conteúdo",
  "discover.capabilities.contentRequirement":
    "Precisa de um projeto com repositório vinculado e com a edição de conteúdo ativada.",
  "discover.capabilities.assetsTitle": "Assets",
  "discover.capabilities.assetsRequirement":
    "Precisa de um bucket de storage vinculado ao nome do site de um projeto.",

  "discover.catalog.title": "Adicionar algo novo",
  "discover.catalog.description":
    "Apps adicionam ferramentas, dados e interfaces a este workspace.",
  "discover.catalog.action": "Explorar o catálogo",
} satisfies Record<keyof typeof en, string>;
