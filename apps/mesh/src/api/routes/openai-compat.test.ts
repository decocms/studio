import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import { createTestSchema } from "../../storage/test-helpers";
import openaiCompatRoutes from "./openai-compat";

// ============================================================================
// Test Fixtures
// ============================================================================

const MOCK_ORG_ID = "org_test123";
const MOCK_ORG_SLUG = "test-org";
const MOCK_USER_ID = "user_test456";
const MOCK_CONNECTION_ID = "conn_llm789";
const MOCK_MODEL_ID = "gpt-4";

// Helper to build the endpoint path
const ENDPOINT = `/${MOCK_ORG_SLUG}/v1/chat/completions`;

function createMockConnection(
  overrides?: Partial<{
    id: string;
    organization_id: string;
    status: string;
  }>,
) {
  return {
    id: overrides?.id ?? MOCK_CONNECTION_ID,
    organization_id: overrides?.organization_id ?? MOCK_ORG_ID,
    status: overrides?.status ?? "active",
    title: "Test LLM Connection",
    url: "https://api.openai.com",
    binding: "llm",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe("OpenAI-compat: Schema Validation", () => {
  let database: TestDatabase;
  let app: Hono<{ Variables: { meshContext: MeshContext } }>;
  let mockFindById: ReturnType<typeof mock>;
  let mockHasPermission: ReturnType<typeof mock>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);

    mockFindById = mock(async () => createMockConnection());
    mockHasPermission = mock(async () => true);

    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // API key auth required
      storage: {
        connections: {
          findById: mockFindById,
        },
      },
      accessControl: {
        hasPermission: mockHasPermission,
      },
    } as unknown as MeshContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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

  it("rejects invalid model format (missing colon separator)", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "invalid-model-format",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("connection_id:model_id");
  });

  it("rejects invalid message role", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
  let database: TestDatabase;
  let app: Hono<{ Variables: { meshContext: MeshContext } }>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    mock.restore();
  });

  it("rejects request without API key (user session only)", async () => {
    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { user: { id: MOCK_USER_ID }, apiKey: null }, // User session but no API key
      storage: {
        connections: {
          findById: mock(async () => createMockConnection()),
        },
      },
    } as unknown as MeshContext;

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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
      storage: {
        connections: {
          findById: mock(async () => createMockConnection()),
        },
      },
    } as unknown as MeshContext;

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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
      storage: {
        connections: {
          findById: mock(async () => createMockConnection()),
        },
      },
    } as unknown as MeshContext;

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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
  let database: TestDatabase;
  let app: Hono<{ Variables: { meshContext: MeshContext } }>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    mock.restore();
  });

  it("rejects when organization slug does not match URL", async () => {
    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: "different-org" }, // Different slug
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // API key auth
      storage: {
        connections: {
          findById: mock(async () => createMockConnection()),
        },
      },
    } as unknown as MeshContext;

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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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

  // Note: Connection-level authorization tests require complex AccessControl mocking
  // These are better tested via integration tests with a real database and auth setup
});

// ============================================================================
// Tools/Function Calling Schema Tests
// ============================================================================

describe("OpenAI-compat: Tools Schema", () => {
  let database: TestDatabase;
  let app: Hono<{ Variables: { meshContext: MeshContext } }>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);

    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // API key auth required
      storage: {
        connections: {
          findById: mock(async () => createMockConnection()),
        },
      },
    } as unknown as MeshContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    mock.restore();
  });

  it("rejects invalid tool type", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
  let database: TestDatabase;
  let app: Hono<{ Variables: { meshContext: MeshContext } }>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);

    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // API key auth required
      storage: {
        connections: {
          findById: mock(async () => createMockConnection()),
        },
      },
    } as unknown as MeshContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    mock.restore();
  });

  it("rejects invalid response_format type", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
  let database: TestDatabase;
  let app: Hono<{ Variables: { meshContext: MeshContext } }>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);

    const ctx = {
      db: database.db,
      organization: { id: MOCK_ORG_ID, slug: MOCK_ORG_SLUG },
      auth: { apiKey: { id: "api_key_123", userId: MOCK_USER_ID } }, // API key auth required
      storage: {
        connections: {
          findById: mock(async () => createMockConnection()),
        },
      },
    } as unknown as MeshContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", openaiCompatRoutes);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    mock.restore();
  });

  it("rejects message with invalid role", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
        model: `${MOCK_CONNECTION_ID}:${MOCK_MODEL_ID}`,
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
