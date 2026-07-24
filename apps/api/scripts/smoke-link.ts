/**
 * smoke-link — verify that a local link daemon is registered and online.
 *
 * Hits `/api/links/me` on the local cluster with a bearer session and
 * fails fast if the status isn't "online". Useful as a quick check
 * before running an integration test that depends on a live link.
 *
 * The link daemon can take a moment to finish registering right after
 * `bun run dev --local-sandbox-provider` or `deco link` starts, so a
 * single check is flaky — this retries with backoff before giving up.
 *
 * Run with: `bun run smoke:link` from `apps/api/`.
 *
 * Required env:
 *   STUDIO_TEST_SESSION  Bearer token for an authenticated session
 *
 * Optional env:
 *   STUDIO_BASE_URL      Cluster base URL (default http://localhost:4000)
 */

import { retry, RetryError } from "@decocms/shared/std";

async function checkOnline(baseUrl: string, token: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/links/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`/api/links/me returned ${res.status}`);
  }
  const body = (await res.json()) as {
    status?: string;
    capabilities?: string[];
  };
  if (body.status !== "online") {
    throw new Error(`link status is "${body.status}", not "online"`);
  }
  return body.capabilities ?? [];
}

async function main(): Promise<void> {
  const baseUrl =
    process.env.STUDIO_BASE_URL ??
    process.env.MESH_BASE_URL ??
    "http://localhost:4000";
  const token =
    process.env.STUDIO_TEST_SESSION ?? process.env.MESH_TEST_SESSION ?? "";
  if (!token) {
    console.error(
      "smoke: STUDIO_TEST_SESSION is not set — pass a bearer token for an authenticated session.",
    );
    process.exit(2);
  }
  try {
    const capabilities = await retry(() => checkOnline(baseUrl, token), {
      maxAttempts: 5,
      minTimeout: 500,
      maxTimeout: 3000,
    });
    console.log("smoke: link online — capabilities", capabilities);
  } catch (err) {
    const cause = err instanceof RetryError ? err.cause : err;
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(
      `smoke: ${message} — start the link with \`bun run dev --local-sandbox-provider\` or \`deco link <studio-url>\``,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("smoke: unexpected error", err);
  process.exit(1);
});
