import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "../../core/studio-context";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import type { MeshDatabase } from "../../database";
import openaiCompatRoutes from "./openai-compat";

// ============================================================================
// Test Fixtures
// ============================================================================

const MOCK_ORG_ID = "org_test123";
const MOCK_ORG_SLUG = "test-org";
const MOCK_USER_ID = "user_test456";
const MOCK_CREDENTIAL_ID = "key_test789";
const MOCK_MODEL_ID = "gpt-4";

// Helper to build the endpoint path
const ENDPOINT = `/${MOCK_ORG_SLUG}/v1/chat/completions`;

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe("OpenAI-compat: Schema Validation", () => {
  let database: MeshDatabase;
  let app: Hono<{ Variables: { meshContext: StudioContext } }>;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);

    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } },
      storage: {
        aiProviderKeys: { list: mock(async () => []) },
      },
      aiProviders: {
        activate: mock(async () => {
          throw new Error("not mocked for schema tests");
        }),
      },
    } as unknown as StudioContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    mock.restore();
  });

  it("rejects request without model field", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    // Error message indicates model field issue
    expect(body.error.message).toContain("Invalid");
  });

  it("rejects request without messages field", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    // Error message indicates messages field issue (expected array)
    expect(body.error.message).toContain("Invalid");
  });

  it("accepts model-only format (no colon) and falls back to default credential", async () => {
    // Model-only format is valid — it will try to resolve org's default credential
    // which fails here because aiProviders.activate is not fully mocked, but the
    // point is it doesn't reject the format itself
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    // Will get 400 because no credentials are configured (mock returns empty list)
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.message).toContain("No AI provider credentials");
  });

  it("rejects invalid message role", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "invalid_role", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects temperature out of range", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
        temperature: 3.0, // max is 2.0
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects negative max_tokens", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: -100,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });
});

// Note: Tests for "accepts valid request with all optional parameters" would require
// full LLM provider mocking which is complex. Schema validation tests above cover
// the parameter acceptance logic.

// ============================================================================
// Authentication Tests
// ============================================================================

describe("OpenAI-compat: Authentication", () => {
  let database: MeshDatabase;
  let app: Hono<{ Variables: { meshContext: StudioContext } }>;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    mock.restore();
  });

  it("rejects request without API key (user session only)", async () => {
    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { user: { id: MOCK_USER_ID }, apiKey: null }, // User session but no API key
      aiProviders: {
        activate: mock(async () => {
          throw new Error("not mocked");
        }),
      },
    } as unknown as StudioContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);

    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    // This endpoint requires API key auth, not user sessions
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("authentication_error");
  });

  it("rejects request without any authentication", async () => {
    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { user: null, apiKey: null }, // No authentication
      aiProviders: {
        activate: mock(async () => {
          throw new Error("not mocked");
        }),
      },
    } as unknown as StudioContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);

    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("authentication_error");
  });

  it("rejects request without organization context", async () => {
    const ctx = {
      db: database.db,
      organization: null, // No organization
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // Has API key
      aiProviders: {
        activate: mock(async () => {
          throw new Error("not mocked");
        }),
      },
    } as unknown as StudioContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);

    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    // Organization context is required
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });
});

// ============================================================================
// Authorization Tests
// ============================================================================

describe("OpenAI-compat: Authorization", () => {
  let database: MeshDatabase;
  let app: Hono<{ Variables: { meshContext: StudioContext } }>;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    mock.restore();
  });

  it("rejects when organization slug does not match URL", async () => {
    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: "different-org" }, // Different slug
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // API key auth
      aiProviders: {
        activate: mock(async () => {
          throw new Error("not mocked");
        }),
      },
    } as unknown as StudioContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);

    // URL uses MOCK_ORG_SLUG ("test-org") but context has "different-org"
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("mismatch");
  });
});

// ============================================================================
// Tools/Function Calling Schema Tests
// ============================================================================

describe("OpenAI-compat: Tools Schema", () => {
  let database: MeshDatabase;
  let app: Hono<{ Variables: { meshContext: StudioContext } }>;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);

    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // API key auth required
      aiProviders: {
        activate: mock(async () => {
          throw new Error("not mocked");
        }),
      },
    } as unknown as StudioContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    mock.restore();
  });

  it("rejects invalid tool type", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "invalid_type", // Must be "function"
            function: {
              name: "test_tool",
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects tool without function name", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: {
              // name is missing
              description: "A test tool",
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects invalid tool_choice value", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "test_tool",
            },
          },
        ],
        tool_choice: "invalid_choice", // Must be auto, none, required, or object
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });
});

// ============================================================================
// Response Format Tests
// ============================================================================

describe("OpenAI-compat: Response Format", () => {
  let database: MeshDatabase;
  let app: Hono<{ Variables: { meshContext: StudioContext } }>;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);

    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // API key auth required
      aiProviders: {
        activate: mock(async () => {
          throw new Error("not mocked");
        }),
      },
    } as unknown as StudioContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    mock.restore();
  });

  it("rejects invalid response_format type", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
        response_format: { type: "invalid_format" },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects json_schema without schema property", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "test",
            // Missing schema property
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects json_schema without name", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "user", content: "Hello" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            // name is missing
            schema: { type: "object" },
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });
});

// ============================================================================
// Message Format Tests
// ============================================================================

describe("OpenAI-compat: Message Formats", () => {
  let database: MeshDatabase;
  let app: Hono<{ Variables: { meshContext: StudioContext } }>;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);

    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // API key auth required
      aiProviders: {
        activate: mock(async () => {
          throw new Error("not mocked");
        }),
      },
    } as unknown as StudioContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    mock.restore();
  });

  it("rejects message with invalid role", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [{ role: "invalid_role", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects user message without content", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [
          { role: "user" }, // Missing content
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects tool message without tool_call_id", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "tool",
            // tool_call_id is missing
            content: "Tool result",
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects multi-part content with invalid part type", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CREDENTIAL_ID}:${MOCK_MODEL_ID}`,
        messages: [
          {
            role: "user",
            content: [{ type: "invalid_part_type", data: "test" }],
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });
});

// Note: Testing malformed JSON in tool call arguments requires reaching the message conversion
// step which happens after permission checks. This is better tested via integration tests
// or by directly testing the convertToAISDKMessages function. The error handling is in place
// and will return a 400 error with details about the malformed JSON.

// Note: Streaming tests require full LLM provider mocking which is complex.
// End-to-end streaming tests should be done via integration tests with a real/mocked LLM service.
