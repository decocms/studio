import type { Binding } from "./bindings.ts";

export interface StudioVaultClientOptions {
  baseUrl: string;
  org: string;
  token: string;
  fetch?: typeof fetch;
}

export interface StudioAccessToken {
  type: "oauth_access_token";
  tokenType: "Bearer" | string;
  accessToken: string;
  expiresAt: string | null;
  scope: string | null;
}

export const createStudioVaultClient = (
  options: StudioVaultClientOptions,
): {
  getAccessToken: (connection: string | Binding) => Promise<StudioAccessToken>;
} => {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    getAccessToken: async (connection) => {
      const connectionId =
        typeof connection === "string" ? connection : connection.value;
      const response = await fetchImpl(
        `${baseUrl}/api/${encodeURIComponent(options.org)}/vault/connections/${encodeURIComponent(connectionId)}/access-token`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Studio vault token request failed: ${response.status}`,
        );
      }

      return (await response.json()) as StudioAccessToken;
    },
  };
};
