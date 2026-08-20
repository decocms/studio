import { describe, expect, it, mock } from "bun:test";
import {
  collectMentionAccountIds,
  jiraBodyToText,
  assertBoardId,
  normalizeSiteUrl,
  textToAdf,
  JiraClient,
  JiraUserDirectory,
} from "./client";

describe("normalizeSiteUrl", () => {
  it("accepts a bare host, a URL, and trailing slashes", () => {
    expect(normalizeSiteUrl("acme.atlassian.net")).toBe(
      "https://acme.atlassian.net",
    );
    expect(normalizeSiteUrl("https://acme.atlassian.net/")).toBe(
      "https://acme.atlassian.net",
    );
    expect(normalizeSiteUrl(" http://acme.atlassian.net/jira ")).toBe(
      "https://acme.atlassian.net",
    );
  });

  it("rejects a dotless host", () => {
    expect(() => normalizeSiteUrl("acme")).toThrow("Invalid Jira site URL");
  });

  it("refuses any host outside Jira Cloud", () => {
    // This URL is fetched server-side with the tenant's credentials and the
    // response surfaces in `last_sync_error`, so a non-Jira host is an SSRF
    // read primitive for anyone holding org:manage.
    for (const host of [
      "169.254.169.254",
      "http://169.254.169.254/latest/meta-data/",
      "localhost:8080",
      "10.0.0.1",
      "internal.svc.cluster.local",
      "atlassian.net",
      "acme.atlassian.net.evil.com",
      "evil.com/acme.atlassian.net",
      "acme.atlassian.net@evil.com",
    ]) {
      expect(() => normalizeSiteUrl(host)).toThrow("Invalid Jira site URL");
    }
  });

  it("is case-insensitive about the host", () => {
    expect(normalizeSiteUrl("ACME.Atlassian.NET")).toBe(
      "https://acme.atlassian.net",
    );
  });
});

describe("assertBoardId", () => {
  it("passes numeric ids and rejects path injection", () => {
    expect(assertBoardId("42")).toBe("42");
    expect(() => assertBoardId("42/../secrets")).toThrow(
      "Invalid Jira board id",
    );
  });
});

describe("jiraBodyToText", () => {
  it("flattens paragraphs and hard breaks, drops marks", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "hardBreak" },
            { type: "text", text: "world" },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Second" }] },
      ],
    };
    expect(jiraBodyToText(adf)).toBe("Hello bold\nworld\n\nSecond");
  });

  it("converts v2-style string bodies (Agile API) to markdown", () => {
    expect(jiraBodyToText("h3. *Title*\nplain wiki text")).toBe(
      "### **Title**\nplain wiki text",
    );
  });

  it("returns empty on null and non-body values", () => {
    expect(jiraBodyToText(null)).toBe("");
    expect(jiraBodyToText(42)).toBe("");
  });
});

describe("jiraBodyToText mentions", () => {
  const mention = (attrs: Record<string, unknown>) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "mention", attrs }] }],
  });

  it("uses the name ADF already carries, stripping its @", () => {
    expect(
      jiraBodyToText(mention({ id: "557058:abc-123", text: "@Ana Souza" })),
    ).toBe("@Ana Souza");
  });

  it("falls back to the resolved name when ADF carries none", () => {
    expect(
      jiraBodyToText(
        mention({ id: "557058:abc-123" }),
        new Map([["557058:abc-123", "Ana Souza"]]),
      ),
    ).toBe("@Ana Souza");
  });

  it("renders an unresolvable mention as @unknown", () => {
    expect(jiraBodyToText(mention({ id: "557058:abc-123" }))).toBe("@unknown");
    expect(jiraBodyToText(mention({ text: "  @  " }))).toBe("@unknown");
  });

  it("collects only the account ids that need a lookup", () => {
    expect(
      collectMentionAccountIds({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: "a", text: "@Ana" } },
              { type: "text", text: " e " },
              { type: "mention", attrs: { id: "b" } },
              { type: "mention", attrs: { id: "b" } },
            ],
          },
        ],
      }),
    ).toEqual(["b"]);
  });

  it("collects account ids from wiki-markup bodies too", () => {
    expect(
      collectMentionAccountIds("cc [~accountid:557058:abc-123] e [~jsmith]"),
    ).toEqual(["557058:abc-123"]);
  });

  it("collects nothing from bodies without mentions", () => {
    expect(collectMentionAccountIds(null)).toEqual([]);
    expect(collectMentionAccountIds("plain text")).toEqual([]);
  });
});

describe("JiraUserDirectory", () => {
  const client = () =>
    new JiraClient("https://acme.atlassian.net", "e@acme.com", "tok");

  async function withFetch<T>(
    handler: (url: string) => Response,
    body: (calls: string[]) => Promise<T>,
  ): Promise<T> {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      calls.push(String(input));
      return handler(String(input));
    }) as unknown as typeof fetch;
    try {
      return await body(calls);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200 });

  it("costs no request when nothing needs resolving", async () => {
    await withFetch(
      () => json({}),
      async (calls) => {
        const names = await new JiraUserDirectory(client()).resolve([]);
        expect(calls).toHaveLength(0);
        expect(names.size).toBe(0);
      },
    );
  });

  it("resolves repeated ids from cache — one request per run", async () => {
    await withFetch(
      () =>
        json({
          values: [
            { accountId: "a", displayName: "Ana Souza" },
            { accountId: "b", displayName: "Bruno Lima" },
          ],
        }),
      async (calls) => {
        const directory = new JiraUserDirectory(client());
        for (let i = 0; i < 50; i++) await directory.resolve(["a", "b"]);
        expect(calls).toHaveLength(1);
        expect(await directory.resolve(["a"])).toEqual(
          new Map([["a", "Ana Souza"]]),
        );
      },
    );
  });

  it("latches off after a 403 so a missing permission costs one request", async () => {
    await withFetch(
      () => new Response("Forbidden", { status: 403 }),
      async (calls) => {
        const directory = new JiraUserDirectory(client());
        for (let i = 0; i < 20; i++) {
          expect((await directory.resolve([`user-${i}`])).size).toBe(0);
        }
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("keeps ids Jira declines to disclose out of the map", async () => {
    await withFetch(
      () =>
        json({ values: [{ accountId: "a", displayName: "Ana" }], total: 1 }),
      async (calls) => {
        const names = await new JiraUserDirectory(client()).resolve([
          "a",
          "b",
          "c",
        ]);
        expect(names).toEqual(new Map([["a", "Ana"]]));
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("pages until a page comes back empty, not on `isLast`", async () => {
    let served = 0;
    await withFetch(
      () =>
        json(
          served < 3
            ? {
                values: [
                  { accountId: `u${served}`, displayName: `U${served++}` },
                ],
              }
            : { values: [] },
        ),
      async (calls) => {
        const names = await new JiraUserDirectory(client()).resolve([
          "u0",
          "u1",
          "u2",
          "u3",
        ]);
        expect(names.size).toBe(3);
        expect(calls).toHaveLength(4);
      },
    );
  });
});

describe("textToAdf", () => {
  it("round-trips through jiraBodyToText, one paragraph per line", () => {
    expect(jiraBodyToText(textToAdf("Alice · via Studio:\nlooks good"))).toBe(
      "Alice · via Studio:\n\nlooks good",
    );
  });

  it("produces a valid empty paragraph for empty input", () => {
    expect(textToAdf("")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [] }],
    });
  });
});

describe("JiraClient", () => {
  it("retries on 503 server error and succeeds on second attempt", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: 503 Service Unavailable
        return new Response(JSON.stringify({ error: "Service Unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Second call: success
      return new Response(
        JSON.stringify({ accountId: "test", displayName: "Test User" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      const result = await client.myself();
      expect(result).toEqual({ accountId: "test", displayName: "Test User" });
      expect(callCount).toBe(2); // Retry happened
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry on 401 Unauthorized", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(async () => {
      callCount++;
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      await expect(client.myself()).rejects.toThrow("401");
      expect(callCount).toBe(1); // No retry on 4xx
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry a 400 whose body happens to contain a network-ish word", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          errorMessages: [
            "The value 'network' does not exist for the field 'status'.",
          ],
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      await expect(client.myself()).rejects.toThrow("400");
      expect(callCount).toBe(1); // The status, not the body text, decides
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries on 429 rate limit error", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "Too Many Requests" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ accountId: "test", displayName: "Test User" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      const result = await client.myself();
      expect(result).toEqual({ accountId: "test", displayName: "Test User" });
      expect(callCount).toBe(2); // Retry happened
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry a 200 response with a malformed JSON body", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(async () => {
      callCount++;
      return new Response("not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      await expect(client.myself()).rejects.toThrow("invalid JSON");
      expect(callCount).toBe(1); // Malformed JSON is deterministic — retrying wastes time
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry addComment on a transient error — a resubmit would duplicate the comment", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(async () => {
      callCount++;
      return new Response(JSON.stringify({ error: "Service Unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      await expect(client.addComment("ISSUE-1", "hi")).rejects.toThrow("503");
      expect(callCount).toBe(1); // No retry — a write must not be resubmitted
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry transitionIssue on a transient error — a resubmit could double-transition", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(async () => {
      callCount++;
      return new Response(JSON.stringify({ error: "Service Unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      await expect(client.transitionIssue("ISSUE-1", "31")).rejects.toThrow(
        "503",
      );
      expect(callCount).toBe(1); // No retry — a write must not be resubmitted
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not coerce a body-read failure on a 200 into an empty success", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(async () => {
      callCount++;
      const response = new Response("", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      response.text = () => Promise.reject(new Error("stream reset"));
      return response;
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      await expect(client.myself()).rejects.toMatchObject({
        cause: {
          message: expect.stringContaining("failed to read response body"),
        },
      });
      expect(callCount).toBeGreaterThan(1); // Retried as a network failure, not returned as undefined
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
