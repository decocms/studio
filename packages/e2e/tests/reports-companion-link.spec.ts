/**
 * Black-box proof that the companion-link write path — a full read-modify-write
 * of `configuration_state` via COLLECTION_CONNECTIONS_UPDATE — does not drop
 * sibling binding keys.
 *
 * Why this matters: COLLECTION_CONNECTIONS_UPDATE persists whatever
 * `configuration_state` object it's given wholesale (see
 * apps/api/src/tools/connection/update.ts: `finalState = data.configuration_state
 * ?? {}`); it does NOT merge server-side. So any caller that links a companion
 * MCP (adding one binding) MUST first read the current state and spread the
 * existing bindings into the write, or it silently clobbers every other
 * binding already configured on that connection. This test exercises exactly
 * that read-modify-write over the real HTTP + self-MCP surface and asserts
 * both bindings survive.
 *
 * `configuration_scopes` is intentionally omitted on both the create and the
 * merge-update: a non-empty scopes array drives a downstream
 * ON_MCP_CONFIGURATION handshake (credential vault grants, workload tokens),
 * which is unrelated to the state-merge contract under test here.
 */
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

interface ConnectionWithState {
  id: string;
  configuration_state?: Record<string, unknown> | null;
}

test("linking a companion merges configuration_state without dropping sibling bindings", async ({
  playwright,
}) => {
  const ctx = await newApiContext(playwright);
  const user = await signUpViaApi(ctx);

  // 1) Create a subject connection ("the CD under test") with an initial
  // binding value in configuration_state. configuration_scopes is omitted so
  // no ON_MCP_CONFIGURATION handshake is attempted on create.
  const created = await callSelfMcpTool<{ item: ConnectionWithState }>(
    ctx,
    user.orgSlug,
    "COLLECTION_CONNECTIONS_CREATE",
    {
      data: {
        title: `cd-under-test ${Date.now()}`,
        connection_type: "HTTP",
        connection_url: "https://example.invalid/mcp",
        configuration_state: {
          GA: { __type: "google-analytics", value: "conn_ga" },
        },
      },
    },
  );
  const cdId = created.item.id;

  // 2) Read-modify-write: GET the current state, spread the existing
  // sibling(s), add a second binding, then UPDATE. This is exactly the
  // pattern a companion-link step must follow — the server does not merge.
  const got = await callSelfMcpTool<{ item: ConnectionWithState | null }>(
    ctx,
    user.orgSlug,
    "COLLECTION_CONNECTIONS_GET",
    { id: cdId },
  );
  const currentState = got.item?.configuration_state ?? {};
  const merged = {
    ...currentState,
    VTEX_STORE: { __type: "vtex", value: "conn_vtex" },
  };
  await callSelfMcpTool(ctx, user.orgSlug, "COLLECTION_CONNECTIONS_UPDATE", {
    id: cdId,
    data: { configuration_state: merged },
  });

  // 3) Assert BOTH bindings persisted. If the caller had instead sent only
  // the new binding (skipping the read-modify-write), the wholesale-overwrite
  // semantics of COLLECTION_CONNECTIONS_UPDATE would have dropped GA here —
  // that's the regression this test guards against.
  const after = await callSelfMcpTool<{ item: ConnectionWithState | null }>(
    ctx,
    user.orgSlug,
    "COLLECTION_CONNECTIONS_GET",
    { id: cdId },
  );
  expect(after.item?.configuration_state).toEqual({
    GA: { __type: "google-analytics", value: "conn_ga" },
    VTEX_STORE: { __type: "vtex", value: "conn_vtex" },
  });

  await ctx.dispose();
});
