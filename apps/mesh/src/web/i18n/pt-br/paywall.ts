import type { paywall as enPaywall } from "../en/paywall.ts";

export const paywall = {
  "paywall.title": "Libere seu assento",
  "paywall.description":
    "Assentos gratuitos só podem ver {org}. Um assento pago libera:",
  "paywall.capability.diagnose":
    "Rode seu diagnóstico toda semana, automaticamente",
  "paywall.capability.plan":
    "Transforme os achados em um plano de trabalho priorizado",
  "paywall.capability.automate":
    "Deixe os agents resolverem os problemas por você",
  "paywall.capability.preview":
    "Pré-visualize e aprove cada mudança antes de publicar",
  "paywall.owner.subscribe": "Assinar",
  "paywall.owner.reassure": "Gerencie seus assentos quando quiser.",
  "paywall.owner.comingSoon": "O checkout está chegando em breve.",
  "paywall.member.hint": "Peça um assento pago a um administrador.",
  "paywall.member.done": "Entendi",
  "paywall.dismiss": "Agora não",
} satisfies Record<keyof typeof enPaywall, string>;
