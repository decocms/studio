import type { Binding } from "./bindings.ts";

export interface StudioVaultClientOptions {
  /** Studio API base URL, usually the `baseUrl` value from the vault bootstrap. */
  baseUrl: string;
  /** Organization slug used in Studio's org-scoped API paths. */
  org: string;
  /** Workload token from Studio's vault bootstrap. Store it only in private runtime storage. */
  token: string;
  /** Optional fetch implementation for tests or non-standard runtimes. */
  fetch?: typeof fetch;
}

/** Current downstream OAuth access token leased from Studio's vault. */
export interface StudioAccessToken {
  type: "oauth_access_token";
  tokenType: "Bearer" | string;
  accessToken: string;
  expiresAt: string | null;
  scope: string | null;
}

/**
 * Saved MCP configuration state decrypted by Studio for a granted target
 * connection.
 *
 * This reads the target connection's saved `configuration_state`; it does not
 * call the target MCP's `MCP_CONFIGURATION` discovery tool. Treat `state` as
 * sensitive because some MCPs store provider API keys or other credentials in
 * configuration state instead of OAuth.
 */
export interface StudioMcpConfiguration {
  type: "mcp_configuration";
  state: Record<string, unknown>;
  scopes: string[];
}

export interface StudioVaultClient {
  /**
   * Read a current downstream OAuth access token for a granted target
   * connection.
   *
   * The runtime configuration must declare
   * `${STATE_KEY}::credential:access-token:read`, where `STATE_KEY` points to a
   * `BindingOf(...)` value. Studio refreshes the downstream OAuth credential
   * when possible and returns only the access token; refresh tokens and OAuth
   * client secrets remain inside Studio.
   */
  getAccessToken: (connection: string | Binding) => Promise<StudioAccessToken>;

  /**
   * Read saved MCP configuration state for a granted target connection.
   *
   * Use this when the target MCP stores provider settings or credentials in its
   * Studio configuration instead of OAuth. The runtime configuration must
   * declare `${STATE_KEY}::credential:configuration:read`, where `STATE_KEY`
   * points to a `BindingOf(...)` value. The returned configuration may contain
   * secrets, so avoid logging it and persist the vault bootstrap only in private
   * runtime storage.
   */
  getConfiguration: (
    connection: string | Binding,
  ) => Promise<StudioMcpConfiguration>;
}

/**
 * Create a client for Studio vault reads from the `vault` bootstrap passed to
 * `configuration.onInstall` or `configuration.onChange`.
 *
 * Prefer passing the resolved `BindingOf(...)` value to client methods so the
 * read stays tied to the connection selected in configuration state. Raw
 * connection ids are accepted for advanced cases.
 */
export const createStudioVaultClient = (
  options: StudioVaultClientOptions,
): StudioVaultClient => {
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
