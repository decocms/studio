import { discoverEndpoint } from "./endpoint";
import type { Session } from "./session";
import { requireSession, type SessionOptions } from "./studio-request";

const DEFAULT_TARGET = "https://studio.decocms.com";

/**
 * Who a command acts as. A run's key and a person's login stay separate
 * credentials; only the commands are shared.
 */
export type Credential =
  /** `STUDIO_API_KEY`, for scripts and CI. */
  | { kind: "apiKey"; target: string; token: string }
  /** The sandbox run's endpoint from `.deco/tools/.endpoint.json`. */
  | { kind: "run"; url: string; headers: Record<string, string> }
  /** The user's login from `decocms auth login`. */
  | { kind: "session"; target: string; token: string; session: Session };

export interface CredentialOptions extends SessionOptions {
  /** Where to look for the sandbox endpoint file. Defaults to the cwd. */
  cwd?: string;
  /** Injectable for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolves the credential in a fixed order: an explicit `--target` means the
 * login for that studio; otherwise `STUDIO_API_KEY`, then the sandbox run's
 * endpoint file, then the login. Returns null after telling the user how to
 * log in.
 */
export async function resolveCredential(
  options: CredentialOptions,
): Promise<Credential | null> {
  const env = options.env ?? process.env;
  if (!options.target) {
    const apiKey = env.STUDIO_API_KEY;
    if (apiKey) {
      return {
        kind: "apiKey",
        target: (env.STUDIO_BASE_URL ?? DEFAULT_TARGET).replace(/\/$/, ""),
        token: apiKey,
      };
    }
    const endpoint = discoverEndpoint(options.cwd);
    if (endpoint) {
      return {
        kind: "run",
        url: endpoint.url,
        headers: endpoint.headers ?? {},
      };
    }
  }
  const session = await requireSession(options);
  return session
    ? {
        kind: "session",
        target: session.target,
        token: session.accessToken,
        session,
      }
    : null;
}

/**
 * A credential for Studio's REST routes. A run's key only covers the run's
 * tools, so a run endpoint is refused here with a pointer to `tools`.
 */
export async function resolveRestCredential(
  options: CredentialOptions,
  command: string,
): Promise<Extract<Credential, { kind: "apiKey" | "session" }> | null> {
  const credential = await resolveCredential(options);
  if (credential?.kind !== "run") return credential;
  console.error(
    `\`decocms ${command}\` needs a login or STUDIO_API_KEY. Inside a Studio run, use \`decocms tools\` with the run's endpoint.`,
  );
  return null;
}
