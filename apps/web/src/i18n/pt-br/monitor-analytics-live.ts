import type { monitorAnalyticsLive as monitorAnalyticsLiveEn } from "../en/monitor-analytics-live.ts";

export const monitorAnalyticsLive = {
  "monitor.analytics.live.live": "Ao vivo",
  "monitor.analytics.live.visitorsNow": "Visitantes agora",
  "monitor.analytics.live.pageviews": "Visualizações",
  "monitor.analytics.live.events": "Eventos",
  "monitor.analytics.live.lastEvent": "Último evento",
  "monitor.analytics.live.loadError":
    "Não foi possível carregar os dados em tempo real.",
  "monitor.analytics.live.notConfigured":
    "Os dados em tempo real ainda não estão disponíveis para este projeto.",
  "monitor.analytics.live.trendTitle": "Últimos 5 minutos",
  "monitor.analytics.live.trendVisitors": "Visitantes",
  "monitor.analytics.live.pagesTitle": "Páginas agora",
  "monitor.analytics.live.pagesVisitors": "Visitantes",
  "monitor.analytics.live.title": "Mapa ao vivo",
} satisfies Record<keyof typeof monitorAnalyticsLiveEn, string>;
