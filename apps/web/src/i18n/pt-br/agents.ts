import type { agents as enAgents } from "../en/agents.ts";

export const agents = {
  "agents.title": "Agentes",
  "agents.subtitle": "O que está rodando agora, e o que roda sem pedir.",
  "agents.tiles.running": "Rodando agora",
  "agents.tiles.runsToday": "Runs hoje",
  "agents.tiles.cost": "Custo de agente · este mês",
  "agents.live.heading": "Rodando agora",
  "agents.live.none": "Nada rodando.",
  "agents.live.noProject": "Sem projeto",
  "agents.schedules.heading": "Agendamentos",
  "agents.schedules.none": "Nada agendado ainda.",
  "agents.schedules.triggers": "{count} gatilhos",
  "agents.schedules.paused": "pausado",
} satisfies Record<keyof typeof enAgents, string>;
