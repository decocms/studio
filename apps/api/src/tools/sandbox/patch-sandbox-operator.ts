import type { SandboxProvider } from "@decocms/sandbox/provider";
import { coAuthorFromStudioContext } from "../../lib/co-author-identity";
import type { StudioContext } from "../../core/studio-context";

/** Sync the authenticated Studio user into daemon tenant config for co-author. */
export async function patchSandboxOperator(
  ctx: StudioContext,
  runner: SandboxProvider,
  handle: string,
): Promise<void> {
  const operator = coAuthorFromStudioContext(ctx);
  if (!operator) return;

  const res = await runner.proxyDaemonRequest(handle, "/_sandbox/config", {
    method: "PUT",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ operator }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to patch sandbox operator (${res.status}): ${body}`,
    );
  }
}
