import { describe, expect, it, mock } from "bun:test";
import {
  jiraBodyToText,
  assertBoardId,
  normalizeSiteUrl,
  textToAdf,
  JiraClient,
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
});
