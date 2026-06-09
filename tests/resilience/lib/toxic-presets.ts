export const PROXY_NAMES = {
  POSTGRES: "postgres",
  NATS: "nats",
  EVERYTHING: "everything",
  STUDIO_WS: "studio_ws",
} as const;

export const MODERATE_LATENCY = {
  type: "latency" as const,
  attributes: { latency: 10_000 },
  name: "moderate-latency",
};

export const HIGH_LATENCY = {
  type: "latency" as const,
  attributes: { latency: 30_000 },
  name: "high-latency",
};

export const EXTREME_LATENCY = {
  type: "latency" as const,
  attributes: { latency: 120_000 },
  name: "extreme-latency",
};

export const CONNECTION_HANG = {
  type: "timeout" as const,
  attributes: { timeout: 5_000 },
  name: "connection-hang",
};

export const DB_MODERATE_LATENCY = {
  type: "latency" as const,
  attributes: { latency: 5_000 },
  name: "db-moderate-latency",
};

export const DB_HIGH_LATENCY = {
  type: "latency" as const,
  attributes: { latency: 15_000 },
  name: "db-high-latency",
};
