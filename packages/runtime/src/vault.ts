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

export interface StudioMcpConfiguration {
  type: "mcp_configuration";
  state: Record<string, unknown>;
  scopes: string[];
}

export const createStudioVaultClient = (
  options: StudioVaultClientOptions,
): {
  getAccessToken: (connection: string | Binding) => Promise<StudioAccessToken>;
  getConfiguration: (
    connection: string | Binding,
  ) => Promise<StudioMcpConfiguration>;
} => {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const connectionIdFor = (connection: string | Binding): string =>
    typeof connection === "string" ? connection : connection.value;

  const postVaultRequest = async <T>(
    connection: string | Binding,
    suffix: "access-token" | "configuration",
    errorLabel: "token" | "configuration",
  ): Promise<T> => {
    const connectionId = connectionIdFor(connection);
    const response = await fetchImpl(
      `${baseUrl}/api/${encodeURIComponent(options.org)}/vault/connections/${encodeURIComponent(connectionId)}/${suffix}`,
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
        `Studio vault ${errorLabel} request failed: ${response.status}`,
      );
    }

    return (await response.json()) as T;
  };

  return {
    getAccessToken: async (connection) =>
      postVaultRequest<StudioAccessToken>(connection, "access-token", "token"),
    getConfiguration: async (connection) =>
      postVaultRequest<StudioMcpConfiguration>(
        connection,
        "configuration",
        "configuration",
      ),
  };
};
