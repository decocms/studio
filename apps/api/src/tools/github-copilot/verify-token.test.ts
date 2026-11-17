import { describe, expect, test } from "bun:test";
import { verifyCopilotToken } from "./verify-token";

const TOKEN = "github_pat_example_secret_value";

function respond(status: number, body = ""): typeof fetch {
  return (async () =>
    new Response(body, { status })) as unknown as typeof fetch;
}

describe("verifyCopilotToken", () => {
  test("accepts a token Copilot answers 200 for", async () => {
    let seen: { url: string; headers: Headers } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers) };
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await verifyCopilotToken(TOKEN, fetchFn);

    expect(seen).not.toBeNull();
    const { url, headers } = seen as unknown as {
      url: string;
      headers: Headers;
    };
    // The same base and integration header the run's env uses.
    expect(url).toBe("https://api.githubcopilot.com/models");
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("copilot-integration-id")).toBe("copilot-developer-cli");
  });

  test("rejects a token without the Copilot Requests permission, with GitHub's reason", async () => {
    const reason =
      'unauthorized: Personal Access Token does not have "Copilot Requests" permission';
    const err = await verifyCopilotToken(
      TOKEN,
      respond(401, `${reason}\n`),
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(reason);
    expect((err as Error).message).toContain("Copilot Requests permission");
  });

  test("rejects on 403 too", async () => {
    await expect(
      verifyCopilotToken(TOKEN, respond(403, "forbidden: no Copilot seat")),
    ).rejects.toThrow(/rejected this token \(forbidden: no Copilot seat\)/);
  });

  test("never echoes the token, even when GitHub does", async () => {
    const err = await verifyCopilotToken(
      TOKEN,
      respond(401, `bad credentials for ${TOKEN}`),
    ).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain("[token]");
  });

  test("fails closed when Copilot can't be reached", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await verifyCopilotToken(TOKEN, fetchFn).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Couldn't reach GitHub Copilot/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  test("fails closed on a server error", async () => {
    await expect(verifyCopilotToken(TOKEN, respond(502))).rejects.toThrow(
      /Couldn't verify the token with GitHub Copilot \(HTTP 502\)/,
    );
  });
});
