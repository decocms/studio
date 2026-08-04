/**
 * Black-box admission boundary between the packaged embedded API and the
 * standalone daemon-compat surface. A local session cookie authenticates the
 * webview, but only account-scoped app-API routes may select sandbox state.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  authHeaders,
  describeEmbeddedLocalApi,
  HOOK_TIMEOUT_MS,
  type LocalApi,
  startEmbeddedLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

describeEmbeddedLocalApi("embedded daemon-route boundary", () => {
  let api: LocalApi | null = null;
  let privateHeaders: Record<string, string> = {};

  beforeAll(async () => {
    api = await startEmbeddedLocalApi();
    const controlOrigin = `http://127.0.0.1:${api.port}`;
    const bootstrap = await fetch(url(api, "/_local/session/bootstrap"), {
      method: "POST",
      headers: authHeaders({ Origin: controlOrigin }),
    });
    expect(bootstrap.status).toBe(204);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("embedded bootstrap did not return a cookie");
    privateHeaders = {
      Cookie: cookie,
      Origin: controlOrigin,
      "Content-Type": "application/json",
    };
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopLocalApi(api);
  }, HOOK_TIMEOUT_MS);

  it("does not expose process-global fs, shell, git, or config routes", async () => {
    if (!api) throw new Error("local-api did not start");
    const victimDir = join(api.workdir, "accounts", "v1", "victim", "repo");
    const sentinel = join(victimDir, "sentinel.txt");
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(sentinel, "preserved");

    const requests: Array<[string, string, unknown?]> = [
      ["POST", "/_sandbox/read", { path: sentinel }],
      ["POST", "/_sandbox/write", { path: sentinel, content: "overwritten" }],
      ["POST", "/_sandbox/bash", { command: "printf compromised" }],
      ["GET", "/_sandbox/git/status"],
      ["GET", "/_sandbox/config"],
    ];

    for (const [method, path, body] of requests) {
      const response = await fetch(url(api, path), {
        method,
        headers: privateHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(404);
    }
    expect(readFileSync(sentinel, "utf8")).toBe("preserved");
  });
});
