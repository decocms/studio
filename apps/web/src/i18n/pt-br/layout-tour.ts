import type { layoutTour as layoutTourEn } from "../en/layout-tour.ts";

export const layoutTour = {
  // ---- Shell.
  "layoutTour.switcher.title": "Um seletor para tudo",
  "layoutTour.switcher.description":
    "Organizações e agentes agora dividem este mesmo controle. Busque nele para ir direto a qualquer agente, inclusive os das suas outras organizações.",
  "layoutTour.nav.title": "A navegação agora fica aqui",
  "layoutTour.nav.description":
    "Tudo o que antes estava espalhado pelo app está neste único painel — seus destinos, o agente que você tem aberto e sua conta no rodapé. Seja o que for que você procura, comece por aqui.",
  "layoutTour.tasks.title": "Acompanhe o trabalho em Tarefas",
  "layoutTour.tasks.description":
    "Cada trabalho que seus agentes assumem aparece aqui como uma tarefa, então você acompanha e direciona tudo em um quadro só, em vez de conversa por conversa.",
  "layoutTour.account.title": "Sua conta e preferências",
  "layoutTour.account.description":
    "Tema, idioma e o resto das suas configurações pessoais ficam atrás do seu nome, no rodapé da barra lateral.",

  // ---- Home da organização.
  "layoutTour.agents.title": "Seus agentes, logo na home",
  "layoutTour.agents.description":
    "A home da organização abre nos agentes que seu time construiu — escolha um para ir direto ao trabalho dele, ou importe um repositório para adicionar outro.",
  "layoutTour.recentActivity.title": "Veja o que esteve rodando",
  "layoutTour.recentActivity.description":
    "As tarefas mais recentes em que seus agentes trabalharam, das mais novas para as mais antigas, para você continuar de onde o time parou.",

  // ---- Escopo de projeto.
  "layoutTour.siteEditor.title": "Edite seu site por aqui",
  "layoutTour.siteEditor.description":
    "Esta linha abre o seu site. Preview, Conteúdo e Código são três vistas da mesma superfície, então mudar uma seção nunca custa o seu lugar.",
  "layoutTour.surfaceTabs.title": "Preview e Conteúdo, lado a lado",
  "layoutTour.surfaceTabs.description":
    "O Preview mostra a página como os visitantes veem; Conteúdo abre os blocos por trás dela. Alterne entre os dois sem sair da página em que você está.",
  "layoutTour.branchPicker.title": "Trabalhe em uma branch",
  "layoutTour.branchPicker.description":
    "As mudanças vão para a branch indicada aqui. Troque para trabalhar em outra e publique quando o trabalho estiver pronto.",
  "layoutTour.automations.title": "Coloque o trabalho no automático",
  "layoutTour.automations.description":
    "Automações rodam este agente por gatilho ou agendamento, então o trabalho recorrente acontece sem ninguém precisar iniciar.",
  "layoutTour.settings.title": "Uma linha de Configurações, dois destinos",
  "layoutTour.settings.description":
    "Com um agente em escopo, ela abre as configurações dele — conexões, modelos e layout. Sem nenhum agente em escopo, abre as da organização: membros, cobrança e como seu time se conecta ao Studio.",

  // ---- Chrome.
  "layoutTour.next": "Avançar",
  "layoutTour.prev": "Voltar",
  "layoutTour.done": "Entendi",
  "layoutTour.skip": "Pular",
  "layoutTour.progress": "{{current}} de {{total}}",
} as const satisfies Record<keyof typeof layoutTourEn, string>;
