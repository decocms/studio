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

/**
 * Every container that holds siblings has to say how they are separated. Only
 * `doc` used to, so a real issue body arrived with its table cells run together
 * ("VerificaçãoResultado…") and its list items run together — all the text
 * present, none of it readable.
 */
describe("jiraBodyToText block structure", () => {
  const para = (text: string) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });
  const doc = (...content: unknown[]) => ({ type: "doc", content });

  it("marks headings by level, clamping one it cannot read", () => {
    expect(
      jiraBodyToText(
        doc(
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Contexto" }],
          },
          {
            type: "heading",
            attrs: { level: 99 },
            content: [{ type: "text", text: "Deep" }],
          },
          { type: "heading", content: [{ type: "text", text: "Level-less" }] },
        ),
      ),
    ).toBe("## Contexto\n\n###### Deep\n\n# Level-less");
  });

  it("keeps a table a table instead of running its cells together", () => {
    const cell = (text: string, type = "tableCell") => ({
      type,
      content: [para(text)],
    });
    expect(
      jiraBodyToText(
        doc({
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                cell("Verificação", "tableHeader"),
                cell("Resultado", "tableHeader"),
              ],
            },
            {
              type: "tableRow",
              content: [cell("#ld-json-product"), cell("não existe")],
            },
          ],
        }),
      ),
    ).toBe(
      "| Verificação | Resultado |\n| --- | --- |\n| #ld-json-product | não existe |",
    );
  });

  it("pads a ragged row and neutralizes a pipe inside a cell", () => {
    const cell = (text: string) => ({
      type: "tableCell",
      content: [para(text)],
    });
    expect(
      jiraBodyToText(
        doc({
          type: "table",
          content: [
            { type: "tableRow", content: [cell("a"), cell("b | c")] },
            { type: "tableRow", content: [cell("only")] },
          ],
        }),
      ),
    ).toBe("| a | b \\| c |\n| --- | --- |\n| only |  |");
  });

  it("folds a multi-line cell onto its row rather than breaking the table", () => {
    expect(
      jiraBodyToText(
        doc({
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [para("one"), para("two")] },
                { type: "tableCell", content: [para("x")] },
              ],
            },
          ],
        }),
      ),
    ).toBe("| one two | x |\n| --- | --- |");
  });

  it("gives every list item its own line", () => {
    expect(
      jiraBodyToText(
        doc({
          type: "bulletList",
          content: [
            { type: "listItem", content: [para("PDP: Product")] },
            { type: "listItem", content: [para("Home: Organization")] },
          ],
        }),
      ),
    ).toBe("- PDP: Product\n- Home: Organization");
  });

  it("numbers an ordered list from where the issue starts it", () => {
    const items = [para("first"), para("second")].map((p) => ({
      type: "listItem",
      content: [p],
    }));
    expect(jiraBodyToText(doc({ type: "orderedList", content: items }))).toBe(
      "1. first\n2. second",
    );
    expect(
      jiraBodyToText(
        doc({ type: "orderedList", attrs: { order: 3 }, content: items }),
      ),
    ).toBe("3. first\n4. second");
  });

  it("renders a task list as checkboxes that keep their state", () => {
    expect(
      jiraBodyToText(
        doc({
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { state: "DONE" },
              content: [{ type: "text", text: "shipped" }],
            },
            {
              type: "taskItem",
              attrs: { state: "TODO" },
              content: [{ type: "text", text: "pending" }],
            },
          ],
        }),
      ),
    ).toBe("- [x] shipped\n- [ ] pending");
  });

  it("keeps an item's second paragraph inside the item", () => {
    expect(
      jiraBodyToText(
        doc({
          type: "bulletList",
          content: [
            { type: "listItem", content: [para("head"), para("tail")] },
            { type: "listItem", content: [para("next")] },
          ],
        }),
      ),
    ).toBe("- head\n\n  tail\n- next");
  });

  it("fences a code block with the language the issue tagged it", () => {
    expect(
      jiraBodyToText(
        doc({
          type: "codeBlock",
          attrs: { language: "js" },
          content: [{ type: "text", text: "var a = 1;\nreturn a;" }],
        }),
      ),
    ).toBe("```js\nvar a = 1;\nreturn a;\n```");
  });

  it("quotes a panel and a blockquote, blank lines included", () => {
    expect(
      jiraBodyToText(
        doc({ type: "panel", content: [para("careful"), para("really")] }),
      ),
    ).toBe("> careful\n>\n> really");
  });

  it("renders a rule, and the inline widgets that carry no text node", () => {
    expect(
      jiraBodyToText(
        doc(
          { type: "rule" },
          {
            type: "paragraph",
            content: [
              { type: "emoji", attrs: { text: "✅", shortName: ":check:" } },
              { type: "text", text: " see " },
              { type: "inlineCard", attrs: { url: "https://example.test/x" } },
            ],
          },
        ),
      ),
    ).toBe("---\n\n✅ see https://example.test/x");
  });

  it("drops media without leaving a blank block, keeping any caption", () => {
    expect(
      jiraBodyToText(
        doc(
          para("before"),
          {
            type: "mediaSingle",
            content: [{ type: "media", attrs: { id: "m1" } }],
          },
          para("after"),
        ),
      ),
    ).toBe("before\n\nafter");
  });

  it("still contributes the text of a node type it does not know", () => {
    expect(
      jiraBodyToText(
        doc({
          type: "somethingNew",
          content: [{ type: "text", text: "kept" }],
        }),
      ),
    ).toBe("kept");
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

  it("posts a comment as rich ADF, with the author line kept unparsed", async () => {
    const bodies: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)).body);
      return new Response(JSON.stringify({ id: "10001" }), { status: 201 });
    }) as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      await client.addComment("ISSUE-1", "**done** in `Footer.json`", {
        header: "Super Agent *no* markup · via Studio:",
      });
      expect(bodies[0]).toEqual({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Super Agent *no* markup · via Studio:" },
            ],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "done", marks: [{ type: "strong" }] },
              { type: "text", text: " in " },
              {
                type: "text",
                text: "Footer.json",
                marks: [{ type: "code" }],
              },
            ],
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to a flat body when Jira rejects the document with a 400", async () => {
    const bodies: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)).body);
      return bodies.length === 1
        ? new Response('{"errors":{"body":"INVALID_INPUT"}}', { status: 400 })
        : new Response(JSON.stringify({ id: "10002" }), { status: 201 });
    }) as unknown as typeof fetch;

    try {
      const client = new JiraClient(
        "https://acme.atlassian.net",
        "user@example.com",
        "token",
      );
      const created = await client.addComment("ISSUE-1", "**done**", {
        header: "Super Agent · via Studio:",
      });
      expect(created).toEqual({ id: "10002" });
      // The mirror survives the rejection, carrying the header and the body.
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(
        textToAdf("Super Agent · via Studio:\n**done**"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("JiraClient.addAttachment", () => {
  const client = () =>
    new JiraClient("https://acme.atlassian.net", "user@example.com", "token");
  const MEDIA = "44d205d6-7f67-4c3e-b58f-e5695f9c828c";

  function stubFetch(handler: (url: string, init: RequestInit) => Response): {
    calls: Array<{ url: string; init: RequestInit }>;
    restore: () => void;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = mock(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as unknown as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = original) };
  }

  it("uploads multipart with the XSRF opt-out and reads the media id off the redirect", async () => {
    const stub = stubFetch((url) =>
      url.endsWith("/attachments")
        ? new Response(JSON.stringify([{ id: "44145" }]), { status: 200 })
        : new Response(null, {
            status: 303,
            headers: {
              location: `https://api.media.atlassian.com/file/${MEDIA}/binary?token=x`,
            },
          }),
    );
    try {
      expect(
        await client().addAttachment("OS-1", {
          name: "shot.png",
          bytes: new Uint8Array([1, 2, 3]),
          contentType: "image/png",
        }),
      ).toEqual({ attachmentId: "44145", mediaId: MEDIA });

      const upload = stub.calls[0];
      expect(upload?.url).toBe(
        "https://acme.atlassian.net/rest/api/3/issue/OS-1/attachments",
      );
      expect(upload?.init.body).toBeInstanceOf(FormData);
      const headers = (upload?.init.headers ?? {}) as Record<string, string>;
      // Jira refuses an unbrowsered multipart POST without this header.
      expect(headers["X-Atlassian-Token"]).toBe("no-check");
      expect(stub.calls[1]?.init.redirect).toBe("manual");
    } finally {
      stub.restore();
    }
  });

  it("falls back to the followed URL when the location header is hidden", async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith("/attachments")) {
        return new Response(JSON.stringify([{ id: "44145" }]), { status: 200 });
      }
      // A filtered opaqueredirect exposes no headers; status 0 is unconstructable.
      if (init.redirect === "manual")
        return new Response(null, { status: 303 });
      const followed = new Response(null, { status: 200 });
      Object.defineProperty(followed, "url", {
        value: `https://api.media.atlassian.com/file/${MEDIA}/binary`,
      });
      return followed;
    });
    try {
      expect(
        (
          await client().addAttachment("OS-1", {
            name: "shot.png",
            bytes: new Uint8Array([1]),
          })
        ).mediaId,
      ).toBe(MEDIA);
    } finally {
      stub.restore();
    }
  });

  it("reports a null media id rather than throwing when no uuid is found", async () => {
    const stub = stubFetch((url) =>
      url.endsWith("/attachments")
        ? new Response(JSON.stringify([{ id: "44145" }]), { status: 200 })
        : new Response(null, { status: 200 }),
    );
    try {
      expect(
        await client().addAttachment("OS-1", {
          name: "shot.png",
          bytes: new Uint8Array([1]),
        }),
      ).toEqual({ attachmentId: "44145", mediaId: null });
    } finally {
      stub.restore();
    }
  });

  it("throws when the upload itself is refused, and never resolves an id", async () => {
    const stub = stubFetch(
      () => new Response("Attachment too large", { status: 413 }),
    );
    try {
      await expect(
        client().addAttachment("OS-1", {
          name: "shot.png",
          bytes: new Uint8Array([1]),
        }),
      ).rejects.toThrow("413");
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });
});

/**
 * The pull's scope and paging. These decide WHICH of a customer's issues exist
 * on their board at all — the reason the sync stopped reading
 * `/board/{id}/issue` (which hides the board's Backlog tab) in the first place.
 */
describe("JiraClient issue reads", () => {
  const client = () =>
    new JiraClient("https://acme.atlassian.net", "e@acme.com", "tok");

  async function withRoutes<T>(
    routes: Array<[RegExp, unknown | (() => Response)]>,
    body: (calls: string[]) => Promise<T>,
  ): Promise<T> {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      for (const [pattern, value] of routes) {
        if (!pattern.test(url)) continue;
        return typeof value === "function"
          ? (value as () => Response)()
          : new Response(JSON.stringify(value), { status: 200 });
      }
      return new Response("not stubbed", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      return await body(calls);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it("scopes the pull to the board's saved filter, ordering trimmed", async () => {
    await withRoutes(
      [
        [/board\/1610\/configuration/, { filter: { id: "77" } }],
        [/filter\/77/, { jql: 'project = "OS" ORDER BY Rank ASC' }],
      ],
      async () => {
        expect(await client().getBoardScopeJql("1610")).toBe('project = "OS"');
      },
    );
  });

  it("refuses to widen scope when the board's filter is unreadable", async () => {
    // Falling back to the project here would put issues that are NOT on this
    // board — another team's, in a shared project — on the customer's board.
    await withRoutes(
      [
        [/board\/1610\/configuration/, { filter: { id: "77" } }],
        [/filter\/77/, () => new Response("Forbidden", { status: 403 })],
        [/board\/1610$/, { location: { projectKey: "OS" } }],
      ],
      async () => {
        await expect(client().getBoardScopeJql("1610")).rejects.toThrow(
          "cannot read",
        );
      },
    );
  });

  it("scopes by project only when the board has no filter at all", async () => {
    await withRoutes(
      [
        [/board\/1610\/configuration/, { filter: null }],
        [/board\/1610$/, { location: { projectKey: "OS" } }],
      ],
      async () => {
        expect(await client().getBoardScopeJql("1610")).toBe('project = "OS"');
      },
    );
  });

  it("refuses to sync a board that exposes neither, rather than pulling everything", async () => {
    await withRoutes(
      [
        [/board\/1610\/configuration/, {}],
        [/board\/1610$/, { location: {} }],
      ],
      async () => {
        await expect(client().getBoardScopeJql("1610")).rejects.toThrow(
          "nothing to sync",
        );
      },
    );
  });

  it("asks for the site's Sprint field and attaches what it finds", async () => {
    await withRoutes(
      [
        [
          /rest\/api\/3\/field/,
          [
            {
              id: "customfield_10020",
              schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" },
            },
          ],
        ],
        [
          /search\/jql/,
          {
            issues: [
              {
                id: "1",
                key: "OS-1",
                fields: {
                  summary: "s",
                  status: { name: "BACKLOG" },
                  priority: null,
                  issuetype: null,
                  updated: "2026-03-02T00:00:00.000Z",
                  description: null,
                  customfield_10020: [
                    { id: 5, name: "Sprint 5", state: "active" },
                  ],
                },
              },
            ],
          },
        ],
      ],
      async (calls) => {
        const page = await client().searchIssues({ jql: "project = OS" });
        expect(page.issues[0]?.sprints.map((s) => s.id)).toEqual(["5"]);
        expect(calls.at(-1)).toContain("customfield_10020");
      },
    );
  });

  it("resolves the Sprint field once per client, even across pages", async () => {
    await withRoutes(
      [
        [/rest\/api\/3\/field/, []],
        [/search\/jql/, { issues: [] }],
      ],
      async (calls) => {
        const shared = client();
        for (let i = 0; i < 3; i++) await shared.searchIssues({ jql: "x" });
        expect(
          calls.filter((url) => /rest\/api\/3\/field/.test(url)),
        ).toHaveLength(1);
      },
    );
  });

  it("syncs without sprints when the site has no Sprint field", async () => {
    await withRoutes(
      [
        [/rest\/api\/3\/field/, [{ id: "summary" }]],
        [
          /search\/jql/,
          {
            issues: [
              {
                id: "1",
                key: "OS-1",
                fields: {
                  summary: "s",
                  status: { name: "BACKLOG" },
                  priority: null,
                  issuetype: null,
                  updated: "2026-03-02T00:00:00.000Z",
                  description: null,
                },
              },
            ],
          },
        ],
      ],
      async (calls) => {
        const page = await client().searchIssues({ jql: "x" });
        expect(page.issues[0]?.sprints).toEqual([]);
        expect(calls.at(-1)).not.toContain("customfield");
      },
    );
  });

  it("fails the read rather than reporting every card as sprintless", async () => {
    // Swallowing this would clear the sprint of every card the run touches.
    await withRoutes(
      [[/rest\/api\/3\/field/, () => new Response("nope", { status: 403 })]],
      async () => {
        await expect(client().searchIssues({ jql: "x" })).rejects.toThrow(
          "403",
        );
      },
    );
  });

  it("reads whichever project's Sprint field the issue actually carries", async () => {
    const sprintField = (id: string) => ({
      id,
      schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" },
    });
    await withRoutes(
      [
        [
          /rest\/api\/3\/field/,
          [sprintField("customfield_10020"), sprintField("customfield_10105")],
        ],
        [
          /search\/jql/,
          {
            issues: [
              {
                id: "1",
                key: "OS-1",
                fields: {
                  summary: "s",
                  status: { name: "BACKLOG" },
                  priority: null,
                  issuetype: null,
                  updated: "2026-03-02T00:00:00.000Z",
                  description: null,
                  customfield_10020: null,
                  customfield_10105: [
                    { id: 9, name: "Sprint 9", state: "active" },
                  ],
                },
              },
            ],
          },
        ],
      ],
      async (calls) => {
        const page = await client().searchIssues({ jql: "x" });
        expect(page.issues[0]?.sprints.map((s) => s.name)).toEqual([
          "Sprint 9",
        ]);
        expect(calls.at(-1)).toContain("customfield_10105");
      },
    );
  });

  it("collects every id in scope, walking pages by token", async () => {
    let served = 0;
    await withRoutes(
      [
        [
          /search\/jql/,
          () =>
            new Response(
              JSON.stringify(
                served++ === 0
                  ? { issues: [{ id: "1" }, { id: "2" }], nextPageToken: "t2" }
                  : { issues: [{ id: "3" }] },
              ),
              { status: 200 },
            ),
        ],
      ],
      async (calls) => {
        expect(await client().searchIssueIds("project = OS")).toEqual(
          new Set(["1", "2", "3"]),
        );
        expect(calls).toHaveLength(2);
        expect(calls[1]).toContain("nextPageToken=t2");
      },
    );
  });

  it("costs no Sprint-field lookup — this sweep asks for ids only", async () => {
    await withRoutes(
      [[/search\/jql/, { issues: [{ id: "1" }] }]],
      async (calls) => {
        await client().searchIssueIds("project = OS");
        expect(calls.some((url) => /rest\/api\/3\/field/.test(url))).toBe(
          false,
        );
        expect(calls[0]).toContain("fields=id");
      },
    );
  });

  it("refuses to answer rather than hand back a truncated scope", async () => {
    // A partial set read as "everything in scope" would archive live cards.
    await withRoutes(
      [
        [
          /search\/jql/,
          () =>
            new Response(
              JSON.stringify({
                issues: Array.from({ length: 1000 }, (_, i) => ({
                  id: `i${i}`,
                })),
                nextPageToken: "always-more",
              }),
              { status: 200 },
            ),
        ],
      ],
      async () => {
        await expect(client().searchIssueIds("project = OS")).rejects.toThrow(
          "refusing to reconcile",
        );
      },
    );
  });

  it("mirrors the board's own sprints, so a closed one stops reading as current", async () => {
    await withRoutes(
      [
        [
          /board\/1610\/sprint/,
          {
            values: [
              { id: 11, name: "Sprint 11", state: "closed" },
              { id: 12, name: "Sprint 12", state: "active" },
            ],
            isLast: true,
          },
        ],
      ],
      async () => {
        expect(
          (await client().listBoardSprints("1610")).map((s) => [
            s.name,
            s.state,
          ]),
        ).toEqual([
          ["Sprint 11", "closed"],
          ["Sprint 12", "active"],
        ]);
      },
    );
  });

  it("treats a board with no sprint support as having none, not as an error", async () => {
    await withRoutes(
      [
        [
          /board\/1610\/sprint/,
          () => new Response("not a scrum board", { status: 400 }),
        ],
      ],
      async () => {
        expect(await client().listBoardSprints("1610")).toEqual([]);
      },
    );
  });

  it("walks pages by token, and reports the end of the walk as null", async () => {
    await withRoutes(
      [
        [/rest\/api\/3\/field/, []],
        [
          /search\/jql/,
          () =>
            new Response(
              JSON.stringify({ issues: [], nextPageToken: "tok-2" }),
              { status: 200 },
            ),
        ],
      ],
      async (calls) => {
        const first = await client().searchIssues({ jql: "x" });
        expect(first.nextPageToken).toBe("tok-2");
        await client().searchIssues({ jql: "x", nextPageToken: "tok-2" });
        expect(calls.at(-1)).toContain("nextPageToken=tok-2");
      },
    );
  });
});
