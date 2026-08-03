import type { AgentSandboxProvider } from "@decocms/sandbox/provider/agent-sandbox";
import { coAuthorFromStudioContext } from "../../lib/co-author-identity";
import { readBoundedText } from "../../lib/bounded-text";
import type { StudioContext } from "../../core/studio-context";

/** Matches the cap `sandbox-proxy.ts` applies to `/_sandbox/config` responses. */
const CONFIG_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

/** Sync the authenticated Studio user into daemon tenant config for co-author. */
export async function patchSandboxOperator(
  ctx: StudioContext,
  runner: AgentSandboxProvider,
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
    const body = await readBoundedText(res, CONFIG_RESPONSE_MAX_BYTES).catch(
      () => res.statusText,
    );
    throw new Error(
      `Failed to patch sandbox operator (${res.status}): ${body}`,
    );
  }
}
