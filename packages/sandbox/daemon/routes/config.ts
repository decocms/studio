import type { TenantConfigStore } from "../config-store";
import type { ApplyResult } from "../config-store/types";
import type { Phase } from "../process/phase-manager";
import type { TenantConfig } from "../types";
import { jsonResponse, parseBase64JsonBody } from "./body-parser";

export interface DaemonState {
  orchestrator: { running: boolean; pending: number };
  ready: boolean;
}

export interface ConfigDeps {
  daemonBootId: string;
  store: TenantConfigStore;
  /**
   * Token-rotation hook. When the request body carries
   * `auth.rotateToken`, the handler invokes this to swap the in-memory
   * token used by `requireToken`. Authorization on the rotation request
   * itself was already verified upstream against the *current* token —
   * so a successful rotation always represents the holder of the prior
   * token handing off to a new one.
   *
   * Optional: when undefined, `auth.rotateToken` is rejected with 400.
   * This keeps the warm-pool bootstrap path opt-in: only entry points
   * that wired a setter accept rotation requests.
   */
  setDaemonToken?: (next: string) => void;
  /** Live orchestrator + probe state for enriched GET response. */
  getState?: () => DaemonState;
  /** Recent setup phases for LLM context. */
  getTasks?: () => Phase[];
}

/** Wire-only — never persisted to TenantConfig. Stripped before `store.apply`. */
interface AuthPatch {
  rotateToken?: string;
}

interface ConfigPatchWire extends Partial<TenantConfig> {
  auth?: AuthPatch;
}

const TOKEN_MIN_LENGTH = 32;
const TOKEN_MAX_LENGTH = 256;

/**
 * GET /_decopilot_vm/config — current TenantConfig plus live daemon state.
 * Always returns 200 (config is null when not yet set) so callers get full
 * state context even on a fresh daemon before the first PUT /config.
 */
export function makeConfigReadHandler(deps: ConfigDeps) {
  return async (): Promise<Response> => {
    const tenant = deps.store.read();
    const state = deps.getState?.();
    return jsonResponse({
      bootId: deps.daemonBootId,
      config: tenant ? stripDerived(tenant) : null,
      orchestrator: state?.orchestrator,
      ready: state?.ready ?? false,
      tasks: deps.getTasks?.(),
    });
  };
}

/**
 * POST /_decopilot_vm/config — set initial tenant config. PUT/POST share
 * the same handler shape: both deep-merge into current. POST is the
 * conventional first-set; PUT is the conventional patch.
 *
 * Optional `auth.rotateToken` swaps the in-memory daemon token before
 * applying the rest of the patch. The rotation runs *first* so a request
 * that successfully authenticated with the prior token transfers ownership
 * to the new one atomically with whatever workload it brings — there is
 * no in-between state where the old token is dead but the new one isn't
 * yet accepted.
 */
export function makeConfigUpdateHandler(deps: ConfigDeps) {
  return async (req: Request): Promise<Response> => {
    let raw: unknown;
    try {
      raw = await parseBase64JsonBody(req);
    } catch (e) {
      return jsonResponse({ error: `bad body: ${(e as Error).message}` }, 400);
    }
    if (!raw || typeof raw !== "object") {
      return jsonResponse({ error: "payload must be an object" }, 400);
    }
    const wire = raw as ConfigPatchWire;
    const auth = wire.auth;
    if (auth !== undefined) {
      const rejection = validateAuthPatch(auth, deps.setDaemonToken);
      if (rejection) return rejection;
      if (auth.rotateToken && deps.setDaemonToken) {
        deps.setDaemonToken(auth.rotateToken);
      }
    }
    const { auth: _strip, ...patch } = wire;
    const result = await deps.store.apply(patch as Partial<TenantConfig>);
    return makeApplyResponse(deps.daemonBootId, result);
  };
}

function validateAuthPatch(
  auth: AuthPatch,
  setter: ConfigDeps["setDaemonToken"],
): Response | null {
  if (typeof auth !== "object" || auth === null) {
    return jsonResponse({ error: "auth must be an object" }, 400);
  }
  if (auth.rotateToken === undefined) return null;
  if (!setter) {
    return jsonResponse(
      { error: "auth.rotateToken not supported on this endpoint" },
      400,
    );
  }
  if (typeof auth.rotateToken !== "string") {
    return jsonResponse({ error: "auth.rotateToken must be a string" }, 400);
  }
  const len = auth.rotateToken.length;
  if (len < TOKEN_MIN_LENGTH || len > TOKEN_MAX_LENGTH) {
    return jsonResponse(
      {
        error: `auth.rotateToken length must be ${TOKEN_MIN_LENGTH}..${TOKEN_MAX_LENGTH}`,
      },
      400,
    );
  }
  return null;
}

function makeApplyResponse(bootId: string, result: ApplyResult): Response {
  if (result.kind === "rejected") {
    const status = inferStatus(result.reason);
    const error = result.detail
      ? `${result.reason}: ${result.detail}`
      : result.reason;
    return jsonResponse({ error }, status);
  }
  return jsonResponse({
    bootId,
    transition: result.transition.kind,
    config: result.after,
  });
}

function inferStatus(reason: string): number {
  if (reason.includes("immutable")) return 409;
  if (reason.startsWith("persistence failed")) return 500;
  return 400;
}

function stripDerived(
  enriched: ReturnType<TenantConfigStore["read"]>,
): TenantConfig | null {
  if (!enriched) return null;
  return {
    git: enriched.git,
    application: enriched.application,
  };
}
