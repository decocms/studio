/** A real HTTP stand-in for the two providers' quota endpoints. */
import { createServer } from "node:http";

const counts = new Map<string, number>();
function handle(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname === "/health") return new Response("ok");
  if (url.pathname === "/count")
    return Response.json({
      count: counts.get(url.searchParams.get("token") ?? "") ?? 0,
    });
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  counts.set(token, (counts.get(token) ?? 0) + 1);
  if (token.startsWith("scope-"))
    return Response.json(
      { error: "Synthetic denied body must not escape" },
      { status: 403 },
    );
  if (token.startsWith("expired-"))
    return new Response("Synthetic invalid token", { status: 401 });
  if (token.startsWith("limited-"))
    return new Response("Synthetic throttling", {
      status: 429,
      headers: { "retry-after": "300" },
    });
  if (token.startsWith("oversized-")) return new Response("x".repeat(65537));
  if (token.startsWith("malformed-"))
    return Response.json({
      rate_limit: { primary_window: { used_percent: "unknown" } },
      five_hour: { utilization: "unknown" },
    });
  if (token.startsWith("unavailable-"))
    return new Response("Synthetic provider failure", { status: 503 });
  if (token.startsWith("empty-")) return Response.json({});
  if (url.pathname === "/codex") {
    if (request.headers.get("ChatGPT-Account-Id") !== "account_example")
      return new Response("Missing account header", { status: 400 });
    const resetAt = Math.floor(Date.now() / 1000) + 7200;
    return Response.json({
      account_id: "account_example",
      email: "user@example.test",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 18000,
          reset_at: resetAt,
        },
        secondary_window: {
          used_percent: 68,
          limit_window_seconds: 604800,
          reset_at: resetAt + 259200,
        },
      },
    });
  }
  if (url.pathname === "/claude") {
    if (request.headers.get("anthropic-beta") !== "oauth-2025-04-20")
      return new Response("Missing OAuth header", { status: 400 });
    return Response.json({
      five_hour: {
        utilization: 100,
        resets_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      seven_day: {
        utilization: 91,
        resets_at: new Date(Date.now() + 172800_000).toISOString(),
      },
    });
  }
  return new Response("not found", { status: 404 });
}

const port = Number(process.env.SUBSCRIPTION_USAGE_STUB_PORT || 4105);
createServer(async (request, response) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value)
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const result = handle(
    new Request(`http://127.0.0.1:${port}${request.url}`, { headers }),
  );
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(await result.text());
}).listen(port, "127.0.0.1", () =>
  console.log(`Subscription usage fixture listening on ${port}`),
);
