import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { State } from "./state.ts";
import { createMCPServer, type AppContext } from "./tools.ts";

describe("createMCPServer tools", () => {
  it("passes vault bootstrap data to onInstall", async () => {
    const vault = {
      baseUrl: "https://studio.example.com",
      org: "test-org",
      subjectConnectionId: "conn_subject",
      token: "studio_wlt_test",
    };
    let receivedVault: unknown;

    const server = createMCPServer({
      configuration: {
        state: z.object({}),
        onInstall: async (_env, ctx) => {
          receivedVault = ctx.vault;
        },
      },
    });

    const requestContext = {
      state: {},
      token: "runtime-token",
      studioUrl: "https://studio.example.com",
      meshUrl: "https://studio.example.com",
      ensureAuthenticated: () => undefined,
      connectionId: "conn_subject",
    };
    const runtimeContext = {
      env: {
        STUDIO_APP_DEPLOYMENT_ID: "deployment_123",
        MESH_APP_DEPLOYMENT_ID: "deployment_123",
        IS_LOCAL: true,
        STUDIO_REQUEST_CONTEXT: requestContext,
        MESH_REQUEST_CONTEXT: requestContext,
      },
      ctx: { waitUntil: () => {} },
    } satisfies AppContext;

    await State.run(runtimeContext, () =>
      server.callTool({
        toolCallId: "ON_MCP_CONFIGURATION",
        toolCallInput: {
          state: {},
          scopes: [],
          firstRun: true,
          vault,
        },
      }),
    );

    expect(receivedVault).toEqual(vault);
  });

  it("passes vault bootstrap data to onChange", async () => {
    const vault = {
      baseUrl: "https://studio.example.com",
      org: "test-org",
      subjectConnectionId: "conn_subject",
      token: "studio_wlt_test",
    };
    let receivedVault: unknown;

    const server = createMCPServer({
      configuration: {
        state: z.object({}),
        onChange: async (_env, ctx) => {
          receivedVault = ctx.vault;
        },
      },
    });

    const requestContext = {
      state: {},
      token: "runtime-token",
      studioUrl: "https://studio.example.com",
      meshUrl: "https://studio.example.com",
      ensureAuthenticated: () => undefined,
      connectionId: "conn_subject",
    };
    const runtimeContext = {
      env: {
        STUDIO_APP_DEPLOYMENT_ID: "deployment_123",
        MESH_APP_DEPLOYMENT_ID: "deployment_123",
        IS_LOCAL: true,
        STUDIO_REQUEST_CONTEXT: requestContext,
        MESH_REQUEST_CONTEXT: requestContext,
      },
      ctx: { waitUntil: () => {} },
    } satisfies AppContext;

    await State.run(runtimeContext, () =>
      server.callTool({
        toolCallId: "ON_MCP_CONFIGURATION",
        toolCallInput: {
          state: {},
          scopes: [],
          firstRun: false,
          vault,
        },
      }),
    );

    expect(receivedVault).toEqual(vault);
  });
});
