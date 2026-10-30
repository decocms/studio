import type { skills as skillsEn } from "../en/skills.ts";

export const skills = {
  "skills.category.storefront": "Storefront",
  "skills.category.performance": "Performance e cache",
  "skills.category.seo": "SEO e visibilidade em IA",
  "skills.category.analytics": "Analytics e conversão",
  "skills.category.migration": "Migração",
  "skills.category.quality": "QA e segurança",
  "skills.category.delivery": "Entrega e gestão",
  "skills.category.content": "Conteúdo e documentos",
  "skills.category.platform": "Plataforma e integrações",
  "skills.category.other": "Outras",
  "skills.bundle.pr-qa": "QA de PR",
  "skills.bundle.pr-qa.description":
    "Checagem visual, QA de e-commerce e checklists de teste num pull request",
  "skills.bundle.pr-review": "Review de PR",
  "skills.bundle.pr-review.description":
    "Revisar, corrigir e fazer merge de pull requests",
  "skills.bundle.storefront-building": "Páginas e seções da loja",
  "skills.bundle.storefront-building.description":
    "Criar páginas, seções e componentes editáveis no CMS",
  "skills.bundle.storefront-performance": "Performance da loja",
  "skills.bundle.storefront-performance.description":
    "Core Web Vitals, payload, imagens e loaders",
  "skills.bundle.caching": "Cache",
  "skills.bundle.caching.description":
    "Cache na borda, em loaders e no CMS sem servir dado errado",
  "skills.bundle.seo-audit": "Auditoria de SEO e IA",
  "skills.bundle.seo-audit.description":
    "SEO técnico, canonicals e como assistentes de IA citam a loja",
  "skills.bundle.store-diagnostic": "Diagnóstico da loja",
  "skills.bundle.store-diagnostic.description":
    "Do briefing ao resumo executivo das oportunidades de uma loja",
  "skills.bundle.conversion-analysis": "Análise de conversão",
  "skills.bundle.conversion-analysis.description":
    "Funil, dispositivo, busca e resultados de A/B",
  "skills.bundle.migration-tanstack": "Migrar para TanStack",
  "skills.bundle.migration-tanstack.description":
    "Levar um site Deco para TanStack com checagem de paridade",
  "skills.bundle.migration-faststore": "Migrar para FastStore",
  "skills.bundle.migration-faststore.description":
    "Levar uma loja para FastStore com checagem de paridade",
  "skills.bundle.go-live": "Pronto para o go-live",
  "skills.bundle.go-live.description":
    "O que checar antes de mandar tráfego para o site novo",
  "skills.bundle.jira-workflow": "Fluxo do Jira",
  "skills.bundle.jira-workflow.description":
    "Executar, revisar, liberar e validar cards do Jira",
  "skills.bundle.office-documents": "Documentos do Office",
  "skills.bundle.office-documents.description":
    "Ler e escrever arquivos Word, PDF, PowerPoint e Excel",
  "skills.bundle.presentations": "Apresentações e marca",
  "skills.bundle.presentations.description":
    "Slides, templates e material dentro da marca",
  "skills.bundle.writing": "Escrita",
  "skills.bundle.writing.description":
    "Texto claro e humano para qualquer público",
  "skills.bundle.security-audit": "Auditoria de segurança",
  "skills.bundle.security-audit.description":
    "Base de segurança e checagens de controle de acesso",
  "skills.bundle.mcp-apps": "Apps e tools MCP",
  "skills.bundle.mcp-apps.description":
    "Criar, publicar e fazer deploy de apps MCP",
  "skills.picker.add": "Adicionar skills",
  "skills.picker.search": "Buscar bundles e skills",
  "skills.picker.empty": "Nada encontrado",
  "skills.picker.bundles": "Bundles",
  "skills.picker.bundleCount": "{count} skills",
  "skills.picker.remove": "Remover {skill}",
  "skills.picker.inherited": "De {scope}",
  "skills.picker.bundleMembers": "Inclui: {names}",
  "skills.picker.bundleEmpty": "Nenhuma skill neste bundle ainda",
  "skills.picker.unknown": "Fora do seu catálogo",
  "skills.catalog.projectEmpty":
    "Nada adicionado ainda. Adicione bundles da biblioteca e os chats deste projeto vão usá-los primeiro.",
  "skills.picker.bundleCountOne": "1 skill",
  "skills.table.category": "Categoria",
  "skills.table.source": "Origem",
  "skills.table.skills": "Skills",
  "skills.table.remove": "Remover",
  "skills.table.addToProject": "Adicionar ao projeto",
  "skills.table.removeFromProject": "Remover do projeto",
  "skills.library.title": "Biblioteca de skills",
  "skills.library.summary":
    "{packages} bundles · {skills} skills prontas para adicionar",
  "skills.library.from": "Dos repositórios de {org}",
  "skills.library.addPackage": "Adicionar {name}",
  "skills.library.individual": "Skills avulsas",
  "skills.library.showAll": "Mostrar todas ({count})",
  "skills.library.browse": "Explorar",
  "skills.library.added": "Adicionada",
} satisfies Record<keyof typeof skillsEn, string>;
