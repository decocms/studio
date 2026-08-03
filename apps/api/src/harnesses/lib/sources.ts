export interface DecopilotSecretModelSource {
  kind: "secret";
  providerId: string;
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
}

/** Model credentials resolved for each supported Decopilot model slot. */
export interface DecopilotSecretModelSources {
  thinking: DecopilotSecretModelSource;
  fast?: DecopilotSecretModelSource;
  smart?: DecopilotSecretModelSource;
  image?: DecopilotSecretModelSource;
  webSearch?: DecopilotSecretModelSource;
  deepResearch?: DecopilotSecretModelSource;
}

export function createSecretModelSource(input: {
  providerId: string;
  apiKey: string;
  modelId: string;
}): DecopilotSecretModelSource {
  if (input.providerId === "openai-compatible") {
    try {
      const parsed = JSON.parse(input.apiKey) as {
        baseUrl?: string;
        apiKey?: string;
      };
      return {
        kind: "secret",
        providerId: input.providerId,
        apiKey: parsed.apiKey ?? "",
        modelId: input.modelId,
        ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      };
    } catch {
      return {
        kind: "secret",
        providerId: input.providerId,
        apiKey: input.apiKey,
        modelId: input.modelId,
      };
    }
  }

  return {
    kind: "secret",
    providerId: input.providerId,
    apiKey: input.apiKey,
    modelId: input.modelId,
  };
}
