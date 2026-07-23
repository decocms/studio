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

/** Thrown when a tool REST call returns a non-2xx status. `status` is the HTTP code. */
class StudioToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StudioToolError";
  }
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
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body — keep the default message
    }
    throw new StudioToolError(message, res.status);
  }

  return (await res.json()) as StudioToolIO[N]["output"];
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
