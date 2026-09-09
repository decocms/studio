/**
 * Typed REST client for builtin/management tools.
 *
 * Replaces the in-browser MCP client (`useMCPClient({ connectionId: "self" })`
 * → `client.callTool(...)`) for the web admin. Calls
 * `POST /api/:org/tools/:toolName` with the arguments as the JSON body and
 * returns the tool's typed output. Auth rides the session cookie (same-origin).
 *
 * Types come from the generated, browser-safe Studio contract package.
 */
import { useProjectContext } from "@/sdk";
import type {
  StudioToolIO,
  StudioToolName,
} from "@decocms/shared/tools/tool-io";

/**
 * The server's machine-readable refusal codes, as sent on a 403 body's `code`.
 *
 * They existed and reached nobody: this client parsed only `{ error }`, so the
 * codes could not be distinguished from any other failure and every fail-open
 * window — first paint, an org switch, a post-upgrade cross-pod skew — ended in
 * a generic error where a paywall belonged.
 */
export const PLAN_REFUSAL_CODES = {
  /** The org's plan does not include the feature. Show the paywall. */
  featureNotInPlan: "feature_not_in_plan",
  /** The org's AI envelope is spent, and its wallet is empty. */
  aiBudgetExhausted: "ai_budget_exhausted",
} as const;

export type PlanRefusalCode =
  (typeof PLAN_REFUSAL_CODES)[keyof typeof PLAN_REFUSAL_CODES];

/** Thrown when a tool REST call returns a non-2xx status. `status` is the HTTP code. */
export class StudioToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The server's `code`, when it sent one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "StudioToolError";
  }
}

/**
 * The plan refusal this error carries, or null.
 *
 * Use it to route a server 403 into the paywall the client already has, rather
 * than a toast. Accepts `unknown` so a React Query `error` can be passed
 * straight in.
 */
export function planRefusalOf(error: unknown): PlanRefusalCode | null {
  if (!(error instanceof StudioToolError)) return null;
  const codes: readonly string[] = Object.values(PLAN_REFUSAL_CODES);
  return codes.includes(error.code ?? "")
    ? (error.code as PlanRefusalCode)
    : null;
}

/**
 * Call a builtin tool over REST. `orgSlug` scopes the org; `name` is the tool
 * identifier (also the permission identifier checked server-side).
 *
 * Exported for non-hook callers (e.g. shared React Query `queryOptions` used by
 * parallel-prefetch batches and by the shell, which runs before
 * `useProjectContext` is available and so can't call `useStudioTools`). In a
 * component/hook prefer `useStudioTools().call`.
 */
export async function callStudioTool<N extends StudioToolName>(
  orgSlug: string,
  name: N,
  input: StudioToolIO[N]["input"],
): Promise<StudioToolIO[N]["output"]> {
  const res = await fetch(
    `/api/${encodeURIComponent(orgSlug)}/tools/${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
    },
  );

  if (!res.ok) {
    let message = `${name} failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      // `code` is what makes a plan refusal actionable — see planRefusalOf.
      if (typeof body?.code === "string") code = body.code;
    } catch {
      // non-JSON error body — keep the default message
    }
    throw new StudioToolError(message, res.status, code);
  }

  try {
    return (await res.json()) as StudioToolIO[N]["output"];
  } catch {
    throw new StudioToolError(
      `${name} returned a non-JSON response`,
      res.status,
    );
  }
}

/**
 * Hook returning a typed tool caller bound to the current org. Use inside
 * React Query `queryFn`/`mutationFn` in place of `client.callTool(...)`:
 *
 *   const studio = useStudioTools();
 *   const settings = await studio.call("ORGANIZATION_SETTINGS_GET", {});
 */
export function useStudioTools() {
  const { org } = useProjectContext();
  const orgSlug = org.slug;
  return {
    orgSlug,
    call: <N extends StudioToolName>(
      name: N,
      input: StudioToolIO[N]["input"],
    ) => callStudioTool(orgSlug, name, input),
  };
}
