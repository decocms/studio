import type { projects as projectsEn } from "../en/projects.ts";

export const projects = {
  "projects.platform.vtex": "VTEX",
  "projects.platform.shopify": "Shopify",
  "projects.platform.wake": "Wake",
  "projects.platform.nuvemshop": "Nuvemshop",
  "projects.platform.linx": "Linx",
  "projects.platform.vnda": "VNDA",

  "projects.home.newProject": "Novo projeto",

  "projects.card.updated": "Atualizado {time}",

  "projects.empty.title": "Seu comércio, um projeto por vez",
  "projects.empty.description":
    "Um site, um app, uma loja. Cada um com suas conexões, seu relatório e seu quadro.",
  "projects.empty.readOnly": "Peça a um admin para criar o primeiro projeto.",

  "projects.new.title": "Novo projeto",
  "projects.new.subtitle": "O que você vai configurar?",
  "projects.new.back": "Voltar",
  "projects.new.create": "Criar projeto",
  "projects.new.creating": "Criando…",
  "projects.new.nameLabel": "Nome do projeto",
  "projects.new.namePlaceholder": "Farm web",
  "projects.new.nameRequired": "Dê um nome ao projeto",
  "projects.new.failed": "Não foi possível criar o projeto",
  "projects.new.created": "{title} está pronto",

  "projects.new.path.repository": "Importar um código",
  "projects.new.path.repository.hint": "Traga o código de um site ou app",
  "projects.new.path.folder": "Nova pasta de projeto",
  "projects.new.path.folder.hint": "Dê o nome agora, conecte depois",

  "projects.new.step.folder.title": "Dê nome ao seu projeto",

  "projects.reports.chooserTitle": "Continuar para Relat\u00f3rios",
  "projects.reports.chooserSubtitle": "Escolha um projeto para continuar",
  "projects.reports.chooserSearch": "Buscar projeto\u2026",
  "projects.reports.chooserEmpty": "Nenhum projeto com esse nome.",
  "projects.reports.status.ready": "Pronto",
  "projects.reports.status.running": "Rodando",
  "projects.reports.status.none": "Não rodou",
  "projects.reports.status.locked": "Bloqueado",

  "projects.connections.orgWide": "Toda a organização",
  "projects.connections.usedBy": "{count} projetos",
  "projects.settings.title": "Projetos",
  "projects.settings.description":
    "Tudo que é escopado por projeto fica aqui: repositórios, conexões, relatório e quadro.",
  "projects.settings.searchPlaceholder": "Buscar projetos…",
  "projects.settings.open": "Abrir",
  "projects.settings.openSettings": "Configurações",
  "projects.settings.orgScopeNote":
    "Membros, cobrança, segurança e provedores de IA continuam sendo da organização.",
  "projects.settings.noResults": "Nenhum projeto corresponde a “{search}”",

  "projects.identity.storeUrlLabel": "URL da loja",
  "projects.identity.storeUrlDescription":
    "A loja no ar. Os relatórios rodam contra este endereço.",
  "projects.flat.viewProject": "Projeto",
  "projects.flat.viewFiles": "Arquivos",
  "projects.apps.heading": "Apps",
  "projects.apps.reports": "Relatório",
  "projects.apps.reportsCaption": "O que está errado na loja",
  "projects.apps.siteEditor": "Editor de site",
  "projects.apps.siteEditorCaption": "Páginas, seções e conteúdo",
  "projects.apps.assets": "Assets",
  "projects.apps.assetsCaption": "Imagens e arquivos que o site usa",
  "projects.apps.hosting": "Hosting",
  "projects.apps.hostingCaption": "Deploys, domínios e ambientes",
  "projects.apps.e2e": "Testes ponta a ponta",
  "projects.apps.e2eCaption": "Fluxos verificados a cada mudança",
  "projects.apps.analytics": "Analytics",
  "projects.apps.analyticsCaption": "Tráfego, conversão e receita",
  "projects.apps.cdn": "Monitor",
  "projects.apps.cdnCaption": "Cache, latência e erros",
  "projects.apps.automations": "Automações",
  "projects.apps.automationsCaption": "Trabalho que roda em agenda",
  "projects.apps.experiments": "Experimentos",
  "projects.apps.experimentsCaption": "Testes A/B e seus resultados",
  "projects.flat.close": "Fechar",
} as const satisfies Record<keyof typeof projectsEn, string>;
