export const PROVIDER_IDS = ["anthropic", "openrouter"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
