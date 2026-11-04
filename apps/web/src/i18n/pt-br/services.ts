import type { services as en } from "../en/services";

export const services = {
  "services.title": "Serviços",
  "services.new": "novo",
  "services.subtitle":
    "Serviços de parceiros que o agente executa no seu site. Contrate, passe o que ele precisa, e o agente abre um épico, planeja as tarefas e faz o trabalho.",
  "services.offeredBy": "Oferecido por {partner}",
  "services.free": "Grátis",
  "services.hire": "Contratar",
  "services.onboarding":
    "Passe ao agente o que ele precisa para começar. Credenciais ficam salvas como segredos da organização. O resto o agente pede no quadro de tarefas.",
  "services.optional": "(opcional)",
  "services.cancel": "Cancelar",
  "services.confirm": "Contratar e começar",
  "services.hiring": "Começando…",
  "services.hireFailed": "Não foi possível iniciar o serviço",
  "services.kickoffTitle": "Planejar e executar: {service}",
  "services.synerise.name": "Busca semântica",
  "services.synerise.description":
    "Troque a busca do seu site pela busca semântica com IA da Synerise: sincronização de catálogo, busca e autocomplete, tracking de comportamento e checagem de relevância nas suas principais buscas.",
  "services.synerise.workspace": "ID do workspace Synerise",
  "services.synerise.apiKey": "API key da Synerise",
  "services.abacatepay.name": "Migração de gateway de pagamento",
  "services.abacatepay.description":
    "Leve seu checkout para a AbacatePay — Pix e cartão, webhooks e um plano de virada testado.",
  "services.abacatepay.apiKey": "API key da AbacatePay",
  "services.abacatepay.currentGateway": "Gateway atual",
} satisfies Record<keyof typeof en, string>;
