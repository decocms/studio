import type { Kysely } from "kysely";

/**
 * Minimal context for the public Private Registry route handlers: a database
 * handle plus a credential vault for decrypting publish tokens.
 *
 * Previously these handlers borrowed the plugin system's `ServerPluginContext`;
 * that type was inlined here when the plugin system was removed.
 */
export interface RegistryRouteContext {
  db: Kysely<unknown>;
  vault: {
    encrypt: (value: string) => Promise<string>;
    decrypt: (value: string) => Promise<string>;
  };
}
