import { afterAll, afterEach, beforeAll } from "bun:test";
import {
  clearReceivedEvents,
  createApiKey,
  getTestSession,
  mcpCall,
} from "./studio-client";
import { pollUntil } from "./poll-until";
import { PROXY_NAMES } from "./toxic-presets";
import { resetAll } from "./toxiproxy";

export const testState = {
  orgId: "",
  apiKey: "",
  cookie: "",
  everythingConnectionId: "",
  subscriberConnectionId: "",
};

export function registerTestHooks() {
  beforeAll(async () => {
    console.log("[setup] Step 1: Waiting for studio health...");
    // 1. Wait for studio to be healthy (120s timeout)
    await pollUntil(
      async () => {
        const res = await fetch("http://127.0.0.1:13000/health/ready");
        return res.ok;
      },
      {
        timeoutMs: 120_000,
        intervalMs: 2000,
        label: "wait-for-studio-healthy",
      },
    );

    // 2. Verify Toxiproxy is reachable
    const toxiRes = await fetch("http://127.0.0.1:18474/version");
    if (!toxiRes.ok) throw new Error("Toxiproxy not reachable");

    // 3. Proxies are pre-created via toxiproxy.json config file at container start.
    //    Verify they exist by checking the Toxiproxy proxy list.
    const proxiesRes = await fetch("http://127.0.0.1:18474/proxies");
    if (!proxiesRes.ok) throw new Error("Failed to list Toxiproxy proxies");
    const proxies = await proxiesRes.json();
    for (const name of [
      PROXY_NAMES.POSTGRES,
      PROXY_NAMES.NATS,
      PROXY_NAMES.EVERYTHING,
      PROXY_NAMES.STUDIO_WS,
    ]) {
      if (!(name in (proxies as Record<string, unknown>))) {
        throw new Error(`Toxiproxy proxy "${name}" not found`);
      }
    }

    console.log("[setup] Step 4: Signing up test user...");
    // 4. Sign up a test user and create an organization
    const session = await getTestSession();
    testState.cookie = session.cookie;
    testState.orgId = session.orgId;

    console.log(
      `[setup] Step 5: Creating API key (orgId: ${testState.orgId})...`,
    );
    // 5. Create API key for subsequent calls
    const { key } = await createApiKey(session.cookie, session.orgId);
    testState.apiKey = key;

    console.log("[setup] Step 6: Registering everything-server connection...");
    // 6. Register everything-server as connection
    const createConnResult = await mcpCall(
      `${testState.orgId}_self`,
      "tools/call",
      {
        name: "COLLECTION_CONNECTIONS_CREATE",
        arguments: {
          data: {
            title: "Everything Server (Resilience Test)",
            connection_type: "HTTP",
            connection_url: "http://toxiproxy:3001/mcp",
            app_name: "everything-server",
          },
        },
      },
      { cookie: testState.cookie },
    );
    const connResultText = createConnResult.result?.content?.[0]?.text;
    const connData = connResultText
      ? JSON.parse(connResultText)
      : createConnResult.result;
    testState.everythingConnectionId = connData?.item?.id ?? connData?.id ?? "";

    console.log("[setup] Step 7: Registering subscriber-mock connection...");
    // 7. Register subscriber-mock as connection
    const createSubResult = await mcpCall(
      `${testState.orgId}_self`,
      "tools/call",
      {
        name: "COLLECTION_CONNECTIONS_CREATE",
        arguments: {
          data: {
            title: "Subscriber Mock (Resilience Test)",
            connection_type: "HTTP",
            connection_url: "http://subscriber-mock:3003/mcp",
            app_name: "subscriber-mock",
          },
        },
      },
      { cookie: testState.cookie },
    );
    const subResultText = createSubResult.result?.content?.[0]?.text;
    const subData = subResultText
      ? JSON.parse(subResultText)
      : createSubResult.result;
    testState.subscriberConnectionId = subData?.item?.id ?? subData?.id ?? "";

    // 8. Baseline check — call echo on everything-server to confirm connectivity
    const baseline = await mcpCall(
      testState.everythingConnectionId,
      "tools/call",
      { name: "echo", arguments: { message: "baseline-check" } },
      { apiKey: testState.apiKey },
    );
    if (!baseline.result) {
      throw new Error(
        "Baseline tool call failed — everything-server not reachable through studio",
      );
    }
    console.log("✓ Setup complete — baseline tool call succeeded");
  }, 180_000);

  afterEach(async () => {
    // Reset all toxics and re-enable all proxies
    await resetAll();
    // Clear subscriber mock received events
    await clearReceivedEvents();
  });

  afterAll(async () => {
    // Cleanup connections (best effort, idempotent)
    try {
      if (testState.everythingConnectionId) {
        await mcpCall(
          `${testState.orgId}_self`,
          "tools/call",
          {
            name: "COLLECTION_CONNECTIONS_DELETE",
            arguments: { id: testState.everythingConnectionId },
          },
          { cookie: testState.cookie },
        );
      }
    } catch {
      /* best effort */
    }
    try {
      if (testState.subscriberConnectionId) {
        await mcpCall(
          `${testState.orgId}_self`,
          "tools/call",
          {
            name: "COLLECTION_CONNECTIONS_DELETE",
            arguments: { id: testState.subscriberConnectionId },
          },
          { cookie: testState.cookie },
        );
      }
    } catch {
      /* best effort */
    }
  });
}
