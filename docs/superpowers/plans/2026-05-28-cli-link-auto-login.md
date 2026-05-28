# CLI Link Auto-Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `decocms link` auto-run interactive login when no session exists (TTY only), silently refresh expired sessions, and adopt the same refresh-only behavior in `decocms auth whoami`.

**Architecture:** Two layered helpers in `apps/mesh/src/cli/lib/`. `getValidSession` reads + silently refreshes (no browser). `ensureSession` wraps `getValidSession` and falls back to interactive login on TTY. `link` uses `ensureSession`; `whoami` uses `getValidSession`. The OAuth flow is extracted from `loginCommand` into a reusable `performInteractiveLogin`. `startLinkDaemon` stops reading the session itself and accepts it as input.

**Tech Stack:** TypeScript, Bun runtime + test runner, OAuth 2.0 + PKCE (existing in `auth/login.ts`), Node `node:fs/promises`.

**Spec:** `docs/superpowers/specs/2026-05-28-cli-link-auto-login-design.md`

---

## File Map

**New files:**
- `apps/mesh/src/cli/lib/refresh-session.ts` — POSTs `grant_type=refresh_token`. Throws typed errors.
- `apps/mesh/src/cli/lib/refresh-session.test.ts`
- `apps/mesh/src/cli/lib/get-valid-session.ts` — refresh-only layer.
- `apps/mesh/src/cli/lib/get-valid-session.test.ts`
- `apps/mesh/src/cli/lib/ensure-session.ts` — auto-login layer.
- `apps/mesh/src/cli/lib/ensure-session.test.ts`

**Modified files:**
- `apps/mesh/src/cli/commands/auth/login.ts` — extract `performInteractiveLogin`.
- `apps/mesh/src/cli/commands/auth/whoami.ts` — switch to `getValidSession`.
- `apps/mesh/src/cli/commands/auth/whoami.test.ts` — add expired-session refresh case.
- `apps/mesh/src/cli/commands/link.ts` — call `ensureSession`, pass session to daemon.
- `apps/mesh/src/link-daemon/index.ts` — `startLinkDaemon` accepts `session` param; remove internal `readSession`.

**Deleted files:**
- `apps/mesh/src/link-daemon/session.ts` — duplicates `cli/lib/session.ts`.

---

## Task 1: `refreshSession` + `RefreshFailedError`

**Files:**
- Create: `apps/mesh/src/cli/lib/refresh-session.ts`
- Create: `apps/mesh/src/cli/lib/refresh-session.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/mesh/src/cli/lib/refresh-session.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Session } from "./session";
import {
  RefreshFailedError,
  refreshSession,
} from "./refresh-session";

const TARGET = "https://studio.decocms.com";
const FIXED_NOW = 1_700_000_000_000; // ms

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    target: TARGET,
    clientId: "client_abc",
    user: { sub: "u_1", email: "tlgimenes@gmail.com" },
    accessToken: "old_at",
    refreshToken: "rt_xyz",
    expiresAt: Math.floor(FIXED_NOW / 1000) - 60, // expired
    createdAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("refreshSession", () => {
  it("returns an updated session on 200 success", async () => {
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${TARGET}/api/auth/mcp/token`);
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rt_xyz");
      expect(body.get("client_id")).toBe("client_abc");
      return new Response(
        JSON.stringify({
          access_token: "new_at",
          refresh_token: "new_rt",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );

    expect(result.accessToken).toBe("new_at");
    expect(result.refreshToken).toBe("new_rt");
    expect(result.expiresAt).toBe(Math.floor(FIXED_NOW / 1000) + 3600);
    expect(result.user).toEqual(makeSession().user);
    expect(result.clientId).toBe("client_abc");
    expect(result.target).toBe(TARGET);
  });

  it("keeps the previous refresh token when the server omits one", async () => {
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({ access_token: "new_at", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );

    expect(result.refreshToken).toBe("rt_xyz");
  });

  it("throws RefreshFailedError(invalid_grant) on 400", async () => {
    const fetchMock = mock(async () => new Response("invalid_grant", { status: 400 }));
    const promise = refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );
    await expect(promise).rejects.toBeInstanceOf(RefreshFailedError);
    await expect(promise).rejects.toMatchObject({ kind: "invalid_grant" });
  });

  it("throws RefreshFailedError(transient) on 500", async () => {
    const fetchMock = mock(async () => new Response("oops", { status: 500 }));
    const promise = refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );
    await expect(promise).rejects.toMatchObject({ kind: "transient" });
  });

  it("throws RefreshFailedError(transient) when fetch rejects", async () => {
    const fetchMock = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const promise = refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );
    await expect(promise).rejects.toMatchObject({ kind: "transient" });
  });

  it("throws when session has no refreshToken", async () => {
    const session = makeSession({ refreshToken: undefined });
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    const promise = refreshSession(
      session,
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );
    await expect(promise).rejects.toMatchObject({ kind: "invalid_grant" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/cli/lib/refresh-session.test.ts`
Expected: FAIL — `Cannot find module './refresh-session'`.

- [ ] **Step 3: Implement `refresh-session.ts`**

Create `apps/mesh/src/cli/lib/refresh-session.ts`:

```typescript
import type { Session } from "./session";

export class RefreshFailedError extends Error {
  readonly kind: "invalid_grant" | "transient";

  constructor(kind: "invalid_grant" | "transient", message: string) {
    super(message);
    this.name = "RefreshFailedError";
    this.kind = kind;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * Exchanges the session's refresh token for a fresh access token.
 *
 * Returns an updated Session object (caller is responsible for persisting it).
 * Throws RefreshFailedError("invalid_grant") if the refresh token is rejected
 * (4xx) or absent; throws RefreshFailedError("transient") for network/server
 * errors (5xx, fetch rejections).
 */
export async function refreshSession(
  session: Session,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Session> {
  if (!session.refreshToken) {
    throw new RefreshFailedError(
      "invalid_grant",
      "Session has no refresh token",
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
  });

  let res: Response;
  try {
    res = await fetchImpl(`${session.target}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    throw new RefreshFailedError(
      "transient",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status >= 400 && res.status < 500) {
      throw new RefreshFailedError(
        "invalid_grant",
        `HTTP ${res.status} ${text}`,
      );
    }
    throw new RefreshFailedError("transient", `HTTP ${res.status} ${text}`);
  }

  const data = (await res.json()) as TokenResponse;
  if (typeof data.access_token !== "string") {
    throw new RefreshFailedError(
      "transient",
      "Token endpoint returned no access_token",
    );
  }

  return {
    ...session,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? session.refreshToken,
    expiresAt: data.expires_in
      ? Math.floor(now() / 1000) + data.expires_in
      : session.expiresAt,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/cli/lib/refresh-session.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/cli/lib/refresh-session.ts apps/mesh/src/cli/lib/refresh-session.test.ts
git commit -m "feat(cli): add refreshSession helper for OAuth refresh-token grant"
```

---

## Task 2: Extract `performInteractiveLogin` from `login.ts`

**Files:**
- Modify: `apps/mesh/src/cli/commands/auth/login.ts`

This task does not add tests — the existing `login.test.ts` covers the full flow through `loginCommand`, and refactoring without changing observable behavior is verified by the existing suite staying green.

- [ ] **Step 1: Refactor `login.ts` to expose `performInteractiveLogin`**

Replace the full contents of `apps/mesh/src/cli/commands/auth/login.ts` with:

```typescript
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startOAuthCallbackServer } from "../../lib/oauth-callback";
import { generatePkcePair } from "../../lib/pkce";
import { type Session, writeSession } from "../../lib/session";

export interface LoginOptions {
  dataDir: string;
  target?: string;
  /** Injectable for tests. Defaults to opening the user's default browser. */
  openBrowser?: (url: string) => Promise<void>;
  /** Injectable for tests. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface PerformInteractiveLoginOptions {
  target?: string;
  openBrowser?: (url: string) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_TARGET = "https://studio.decocms.com";

const SCOPES = "openid profile email offline_access";

interface RegisterResponse {
  client_id: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface IdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
}

/**
 * Runs the OAuth 2.0 + PKCE flow and returns a fresh Session object.
 *
 * Does NOT write the session to disk — callers (`loginCommand`,
 * `ensureSession`) are responsible for persistence.
 */
export async function performInteractiveLogin(
  options: PerformInteractiveLoginOptions = {},
): Promise<Session> {
  const target = (options.target ?? DEFAULT_TARGET).replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const openImpl = options.openBrowser ?? defaultOpenBrowser;

  const state = randomUUID();
  const pkce = generatePkcePair();

  const server = await startOAuthCallbackServer({
    expectedState: state,
    successRedirectUrl: `${target}/cli/auth-success`,
  });
  try {
    const redirectUri = `${server.url}/`;
    const clientId = await registerClient(fetchImpl, target, redirectUri);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      scope: SCOPES,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
    const url = `${target}/login?${params.toString()}`;

    console.log(`Opening ${url} in your browser...`);
    await openImpl(url);

    const { code } = await server.waitForCallback();

    const token = await exchangeToken(
      fetchImpl,
      target,
      clientId,
      code,
      redirectUri,
      pkce.verifier,
    );

    if (!token.id_token) {
      throw new Error("Token endpoint returned no id_token");
    }
    const claims = decodeIdToken(token.id_token);

    return {
      target,
      clientId,
      user: { sub: claims.sub, email: claims.email, name: claims.name },
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in
        ? Math.floor(Date.now() / 1000) + token.expires_in
        : undefined,
      createdAt: new Date().toISOString(),
    };
  } finally {
    server.close();
  }
}

export async function loginCommand(options: LoginOptions): Promise<number> {
  try {
    const session = await performInteractiveLogin({
      target: options.target,
      openBrowser: options.openBrowser,
      fetch: options.fetch,
    });
    await writeSession(options.dataDir, session);
    console.log(
      `Logged in as ${session.user.email ?? session.user.sub}.`,
    );
    return 0;
  } catch (err) {
    console.error(
      `Login failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

async function registerClient(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  target: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetchImpl(`${target}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "decocms-cli",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Client registration failed: HTTP ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const data = (await res.json()) as RegisterResponse;
  if (typeof data?.client_id !== "string") {
    throw new Error("Client registration returned no client_id");
  }
  return data.client_id;
}

async function exchangeToken(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  target: string,
  clientId: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetchImpl(`${target}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      `Token exchange failed: HTTP ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const data = (await res.json()) as TokenResponse;
  if (typeof data?.access_token !== "string") {
    throw new Error("Token endpoint returned no access_token");
  }
  return data;
}

function decodeIdToken(idToken: string): IdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("id_token is not a valid JWT");
  }
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  if (typeof payload.sub !== "string") {
    throw new Error("id_token has no sub claim");
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}

async function defaultOpenBrowser(url: string): Promise<void> {
  let command: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      command = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      command = "xdg-open";
      args = [url];
      break;
  }
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      console.log(
        `Could not open browser automatically. Please open this URL manually:\n  ${url}`,
      );
      resolve();
    });
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
```

- [ ] **Step 2: Run the existing login test suite to verify refactor preserves behavior**

Run: `bun test apps/mesh/src/cli/commands/auth/login.test.ts`
Expected: All 4 tests pass (the same set that passed before the refactor).

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/cli/commands/auth/login.ts
git commit -m "refactor(cli): extract performInteractiveLogin from loginCommand"
```

---

## Task 3: `getValidSession`

**Files:**
- Create: `apps/mesh/src/cli/lib/get-valid-session.ts`
- Create: `apps/mesh/src/cli/lib/get-valid-session.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/mesh/src/cli/lib/get-valid-session.test.ts`:

```typescript
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidSession } from "./get-valid-session";
import { readSession, type Session, writeSession } from "./session";

const TARGET = "https://studio.decocms.com";
const FIXED_NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(FIXED_NOW_MS / 1000);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-getvalid-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    target: TARGET,
    clientId: "client_abc",
    user: { sub: "u_1", email: "tlgimenes@gmail.com" },
    accessToken: "at_old",
    refreshToken: "rt_xyz",
    expiresAt: NOW_S + 3600, // fresh
    createdAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("getValidSession", () => {
  it("returns null when no session file exists", async () => {
    const result = await getValidSession({
      dataDir: dir,
      fetch: mock(async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result).toBeNull();
  });

  it("returns the session when it is fresh", async () => {
    await writeSession(dir, makeSession());
    const fetchMock = mock(async () => {
      throw new Error("fetch should not be called for fresh session");
    });
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result?.accessToken).toBe("at_old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a session as expired within the 60s skew window", async () => {
    // expiresAt is 30s in the future — still inside the skew window.
    await writeSession(dir, makeSession({ expiresAt: NOW_S + 30 }));
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ access_token: "at_new", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result?.accessToken).toBe("at_new");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("refreshes an expired session and rewrites it to disk", async () => {
    await writeSession(dir, makeSession({ expiresAt: NOW_S - 60 }));
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "at_new",
            refresh_token: "rt_new",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result?.accessToken).toBe("at_new");
    expect(result?.refreshToken).toBe("rt_new");

    const onDisk = await readSession(dir);
    expect(onDisk?.accessToken).toBe("at_new");
    expect(onDisk?.refreshToken).toBe("rt_new");
  });

  it("returns null when an expired session has no refresh token", async () => {
    await writeSession(
      dir,
      makeSession({ expiresAt: NOW_S - 60, refreshToken: undefined }),
    );
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result).toBeNull();
  });

  it("returns null when refresh fails with invalid_grant", async () => {
    await writeSession(dir, makeSession({ expiresAt: NOW_S - 60 }));
    const fetchMock = mock(async () => new Response("invalid_grant", { status: 400 }));
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result).toBeNull();
  });

  it("rethrows when refresh fails with a transient error", async () => {
    await writeSession(dir, makeSession({ expiresAt: NOW_S - 60 }));
    const fetchMock = mock(async () => new Response("oops", { status: 500 }));
    const promise = getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    await expect(promise).rejects.toMatchObject({ kind: "transient" });
  });

  it("returns the session as-is when expiresAt is undefined", async () => {
    await writeSession(dir, makeSession({ expiresAt: undefined }));
    const fetchMock = mock(async () => {
      throw new Error("fetch should not be called when expiresAt is unknown");
    });
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result?.accessToken).toBe("at_old");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `bun test apps/mesh/src/cli/lib/get-valid-session.test.ts`
Expected: FAIL — `Cannot find module './get-valid-session'`.

- [ ] **Step 3: Implement `get-valid-session.ts`**

Create `apps/mesh/src/cli/lib/get-valid-session.ts`:

```typescript
import { RefreshFailedError, refreshSession } from "./refresh-session";
import { readSession, type Session, writeSession } from "./session";

/** Treat a session as expired this many seconds before its declared expiry, to avoid races. */
const EXPIRY_SKEW_SECONDS = 60;

export interface GetValidSessionOptions {
  dataDir: string;
  fetch?: typeof fetch;
  /** Returns the current time in milliseconds. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Reads the session from disk and silently refreshes it when expired.
 *
 * Returns null when:
 *  - no session file exists, OR
 *  - the session is expired and has no refresh token, OR
 *  - the refresh token is rejected by the server (invalid_grant).
 *
 * Throws RefreshFailedError("transient") when the refresh request fails
 * for network/server reasons (5xx, fetch rejection) — callers can decide
 * whether to surface this to the user or attempt interactive login.
 *
 * Never opens a browser.
 */
export async function getValidSession(
  opts: GetValidSessionOptions,
): Promise<Session | null> {
  const session = await readSession(opts.dataDir);
  if (!session) return null;

  const now = opts.now ?? Date.now;
  if (!isExpired(session, now())) return session;

  try {
    const refreshed = await refreshSession(session, opts.fetch, now);
    await writeSession(opts.dataDir, refreshed);
    return refreshed;
  } catch (err) {
    if (err instanceof RefreshFailedError && err.kind === "invalid_grant") {
      return null;
    }
    throw err;
  }
}

function isExpired(session: Session, nowMs: number): boolean {
  if (session.expiresAt === undefined) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  return session.expiresAt - EXPIRY_SKEW_SECONDS < nowSeconds;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/cli/lib/get-valid-session.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/cli/lib/get-valid-session.ts apps/mesh/src/cli/lib/get-valid-session.test.ts
git commit -m "feat(cli): add getValidSession (refresh-only, no browser)"
```

---

## Task 4: `ensureSession`

**Files:**
- Create: `apps/mesh/src/cli/lib/ensure-session.ts`
- Create: `apps/mesh/src/cli/lib/ensure-session.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/mesh/src/cli/lib/ensure-session.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "./ensure-session";
import { readSession, type Session, writeSession } from "./session";

const TARGET = "https://studio.decocms.com";
const FIXED_NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(FIXED_NOW_MS / 1000);

let dir: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-ensure-"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

function freshSession(): Session {
  return {
    target: TARGET,
    clientId: "client_abc",
    user: { sub: "u_1", email: "tlgimenes@gmail.com" },
    accessToken: "at_old",
    refreshToken: "rt_xyz",
    expiresAt: NOW_S + 3600,
    createdAt: "2026-05-28T00:00:00.000Z",
  };
}

/**
 * Build a fetch mock that simulates the full OAuth flow (register + token
 * exchange) and an openBrowser that triggers the callback. Reused across
 * tests that need ensureSession to run the interactive login path.
 */
function mockOAuth() {
  let clientId = "";
  let code = "";
  const fetchMock = mock(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/auth/mcp/register")) {
      clientId = "client_new";
      return new Response(JSON.stringify({ client_id: clientId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/auth/mcp/token")) {
      const body = new URLSearchParams(init?.body as string);
      // ensureSession's login path only handles authorization_code (refresh
      // is the upstream layer's job).
      expect(body.get("grant_type")).toBe("authorization_code");
      const idTokenPayload = Buffer.from(
        JSON.stringify({
          sub: "u_login",
          email: "tlgimenes@gmail.com",
          name: "TL",
        }),
      ).toString("base64url");
      return new Response(
        JSON.stringify({
          access_token: "at_login",
          refresh_token: "rt_login",
          expires_in: 3600,
          id_token: `h.${idTokenPayload}.s`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const openBrowser = mock(async (url: string) => {
    const parsed = new URL(url);
    const redirectUri = parsed.searchParams.get("redirect_uri")!;
    const state = parsed.searchParams.get("state")!;
    code = "code_test";
    await new Promise((r) => setTimeout(r, 10));
    await fetch(`${redirectUri}?code=${code}&state=${state}`);
  });

  return { fetchMock, openBrowser };
}

describe("ensureSession", () => {
  it("returns the session unchanged when one is already valid", async () => {
    await writeSession(dir, freshSession());
    const openBrowser = mock(async () => {
      throw new Error("should not open browser");
    });
    const fetchMock = mock(async () => {
      throw new Error("should not fetch");
    });

    const session = await ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: true,
      openBrowser,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });

    expect(session.accessToken).toBe("at_old");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("runs interactive login when no session exists and TTY is interactive", async () => {
    const m = mockOAuth();
    const session = await ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: true,
      openBrowser: m.openBrowser,
      fetch: m.fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });

    expect(session.accessToken).toBe("at_login");
    expect(session.user.sub).toBe("u_login");

    // Persisted to disk.
    const onDisk = await readSession(dir);
    expect(onDisk?.accessToken).toBe("at_login");

    // Surfaces a user-facing message that mentions the intent.
    const logged = logSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/sign in to Link/i);
  });

  it("throws when no session exists and TTY is non-interactive", async () => {
    const openBrowser = mock(async () => {
      throw new Error("should not open browser");
    });
    const promise = ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: false,
      openBrowser,
      fetch: mock(async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    await expect(promise).rejects.toThrow(/deco auth login/);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("rethrows transient refresh errors without opening a browser", async () => {
    await writeSession(dir, { ...freshSession(), expiresAt: NOW_S - 60 });
    const openBrowser = mock(async () => {
      throw new Error("should not open browser");
    });
    const fetchMock = mock(async () => new Response("oops", { status: 500 }));

    const promise = ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: true,
      openBrowser,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    await expect(promise).rejects.toMatchObject({ kind: "transient" });
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("falls back to interactive login when refresh token is rejected", async () => {
    await writeSession(dir, { ...freshSession(), expiresAt: NOW_S - 60 });

    // First call is the refresh (rejected with invalid_grant), then the
    // login flow's register + authorization_code token exchange.
    let call = 0;
    const oauth = mockOAuth();
    const fetchMock = mock(
      async (url: string, init?: RequestInit): Promise<Response> => {
        call++;
        if (call === 1) {
          const body = new URLSearchParams(init?.body as string);
          expect(body.get("grant_type")).toBe("refresh_token");
          return new Response("invalid_grant", { status: 400 });
        }
        return oauth.fetchMock(url, init);
      },
    );

    const session = await ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: true,
      openBrowser: oauth.openBrowser,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });

    expect(session.accessToken).toBe("at_login");
    expect(oauth.openBrowser).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `bun test apps/mesh/src/cli/lib/ensure-session.test.ts`
Expected: FAIL — `Cannot find module './ensure-session'`.

- [ ] **Step 3: Implement `ensure-session.ts`**

Create `apps/mesh/src/cli/lib/ensure-session.ts`:

```typescript
import { performInteractiveLogin } from "../commands/auth/login";
import { getValidSession } from "./get-valid-session";
import { type Session, writeSession } from "./session";

export interface EnsureSessionOptions {
  dataDir: string;
  /** Human-readable name of the action requiring auth, e.g. "Link". */
  intent: string;
  /** Defaults to `process.stdout.isTTY`. */
  isInteractive?: boolean;
  // Injectables (all default to real implementations):
  openBrowser?: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Returns a known-valid session, running interactive login when needed.
 *
 * Behavior:
 *  - Valid session on disk → returned as-is.
 *  - Expired session, refresh succeeds → returned (and rewritten to disk).
 *  - No session or refresh rejected, and TTY is interactive → runs OAuth
 *    login, persists the result, and returns it.
 *  - No session or refresh rejected, and TTY is non-interactive → throws
 *    the standard "No session found" error.
 *  - Transient refresh failure (network/5xx) → rethrows. A browser-login
 *    attempt would likely fail the same way; surface the diagnostic instead.
 */
export async function ensureSession(
  opts: EnsureSessionOptions,
): Promise<Session> {
  const isInteractive =
    opts.isInteractive ?? Boolean(process.stdout.isTTY);

  const existing = await getValidSession({
    dataDir: opts.dataDir,
    fetch: opts.fetch,
    now: opts.now,
  });
  if (existing) return existing;

  if (!isInteractive) {
    throw new Error(
      "No session found. Run `deco auth login` first, then re-run the command.",
    );
  }

  console.log(
    `Not logged in — opening browser to sign in to ${opts.intent}.`,
  );

  const session = await performInteractiveLogin({
    openBrowser: opts.openBrowser,
    fetch: opts.fetch,
  });
  await writeSession(opts.dataDir, session);
  console.log(`Logged in as ${session.user.email ?? session.user.sub}.`);
  return session;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/cli/lib/ensure-session.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Run the broader test suite to confirm nothing regressed**

Run: `bun test apps/mesh/src/cli`
Expected: All CLI tests pass (login, whoami, logout, refresh-session, get-valid-session, ensure-session, plus session storage).

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/cli/lib/ensure-session.ts apps/mesh/src/cli/lib/ensure-session.test.ts
git commit -m "feat(cli): add ensureSession with interactive-login fallback"
```

---

## Task 5: Plumb session into `startLinkDaemon`; delete duplicate session module

**Files:**
- Modify: `apps/mesh/src/link-daemon/index.ts`
- Delete: `apps/mesh/src/link-daemon/session.ts`

This change updates `startLinkDaemon`'s signature: callers must now pass a `Session`. The only caller in this branch is `runLinkCommand`, which we'll update in Task 6.

- [ ] **Step 1: Update `startLinkDaemon` to accept a session**

In `apps/mesh/src/link-daemon/index.ts`, change the import and the `StartLinkDaemonOptions` interface, and remove the internal `readSession` call.

Replace:

```typescript
import { readSession } from "./session";
```

with:

```typescript
import type { Session } from "../cli/lib/session";
```

Replace:

```typescript
export interface StartLinkDaemonOptions {
  port: number;
  clusterBaseUrl: string;
  dataDir: string;
}
```

with:

```typescript
export interface StartLinkDaemonOptions {
  port: number;
  clusterBaseUrl: string;
  dataDir: string;
  /**
   * Authenticated session used to bind the WebSocket to the cluster.
   * Callers (e.g. the CLI's `link` command) obtain this via
   * `ensureSession()` before invoking the daemon.
   */
  session: Session;
}
```

Inside `startLinkDaemon`, remove the block:

```typescript
const session = await readSession(opts.dataDir);
if (!session) {
  throw new Error(
    "No session found. Run `deco auth login` first, then re-run `deco link`.",
  );
}
```

…and replace it with a single line that pulls the session off `opts`:

```typescript
const session = opts.session;
```

- [ ] **Step 2: Delete the duplicate session module**

```bash
rm apps/mesh/src/link-daemon/session.ts
```

- [ ] **Step 3: Confirm no other importers of the deleted file**

Run:
```bash
grep -rn "link-daemon/session" apps/mesh/src
```
Expected: no matches (the only consumer was `link-daemon/index.ts`, now updated).

Note: do NOT run `bun run check` here. The whole-project typecheck will fail because `apps/mesh/src/cli/commands/link.ts` no longer satisfies the updated `StartLinkDaemonOptions` (it doesn't pass `session` yet). Task 6 fixes that and runs the typecheck.

- [ ] **Step 4: Format**

```bash
bun run fmt
```

- [ ] **Step 5: Commit (intermediate state — `link.ts` is type-broken until Task 6)**

```bash
git add apps/mesh/src/link-daemon/index.ts apps/mesh/src/link-daemon/session.ts
git commit -m "refactor(link-daemon): accept session as input, delete duplicate session module"
```

---

## Task 6: Wire `link` command to `ensureSession`

**Files:**
- Modify: `apps/mesh/src/cli/commands/link.ts`

- [ ] **Step 1: Update `runLinkCommand` to call `ensureSession`**

Replace the full contents of `apps/mesh/src/cli/commands/link.ts` with:

```typescript
/**
 * `deco link` — start the desktop-side link daemon.
 *
 * Opens a WebSocket to `<MESH_CLUSTER_URL>/api/links/connect` and runs a
 * local ingress on `--port` for `<handle>.localhost` sandbox previews.
 *
 * Auth: calls `ensureSession` first. If the user has no session and is
 * running interactively, an OAuth login is launched inline. In CI / non-
 * interactive shells, surfaces a hard error.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "../lib/ensure-session";
import { startLinkDaemon } from "../../link-daemon";

export interface LinkCommandOptions {
  port?: number;
  clusterBaseUrl?: string;
  dataDir?: string;
}

export async function runLinkCommand(
  opts: LinkCommandOptions = {},
): Promise<number> {
  const port = opts.port ?? 5174;
  const dataDir =
    opts.dataDir ??
    process.env.DATA_DIR ??
    process.env.DECOCMS_HOME ??
    join(homedir(), "deco");
  const clusterBaseUrl =
    opts.clusterBaseUrl ??
    process.env.MESH_CLUSTER_URL ??
    "https://studio.decocms.com";

  try {
    const session = await ensureSession({ dataDir, intent: "Link" });
    const handle = await startLinkDaemon({
      port,
      clusterBaseUrl,
      dataDir,
      session,
    });
    return handle.stopped;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
```

- [ ] **Step 2: Run the full type check + CLI tests**

Run:
```bash
bun run check 2>&1 | tail -30
```
Expected: passes (no TypeScript errors).

Run:
```bash
bun test apps/mesh/src/cli
```
Expected: all CLI tests pass.

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/cli/commands/link.ts
git commit -m "feat(cli): auto-login from \`decocms link\` when not signed in"
```

---

## Task 7: `whoami` adopts `getValidSession`

**Files:**
- Modify: `apps/mesh/src/cli/commands/auth/whoami.ts`
- Modify: `apps/mesh/src/cli/commands/auth/whoami.test.ts`

- [ ] **Step 1: Update imports in `whoami.test.ts`**

Replace the existing top-of-file imports:

```typescript
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../../lib/session";
import { whoamiCommand } from "./whoami";
```

with:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, writeSession } from "../../lib/session";
import { whoamiCommand } from "./whoami";
```

- [ ] **Step 2: Add the failing tests for refresh-on-expired cases**

Append to `apps/mesh/src/cli/commands/auth/whoami.test.ts` (inside the existing `describe("whoamiCommand", ...)` block, before its closing `});`):

```typescript
  it("silently refreshes an expired session and prints the new identity", async () => {
    const nowMs = 1_700_000_000_000;
    const nowS = Math.floor(nowMs / 1000);

    await writeSession(dir, {
      target: "https://studio.decocms.com",
      clientId: "client_abc",
      user: { sub: "u_1", email: "tlgimenes@gmail.com" },
      accessToken: "at_stale",
      refreshToken: "rt_xyz",
      expiresAt: nowS - 60,
      createdAt: "2026-05-04T00:00:00.000Z",
    });

    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ access_token: "at_fresh", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const code = await whoamiCommand({
      dataDir: dir,
      fetch: fetchMock,
      now: () => nowMs,
    });

    expect(code).toBe(0);
    const joined = logs.join("\n");
    expect(joined).toContain("tlgimenes@gmail.com");

    const onDisk = await readSession(dir);
    expect(onDisk?.accessToken).toBe("at_fresh");
  });

  it("prints not-logged-in when refresh is rejected", async () => {
    const nowMs = 1_700_000_000_000;
    const nowS = Math.floor(nowMs / 1000);

    await writeSession(dir, {
      target: "https://studio.decocms.com",
      clientId: "client_abc",
      user: { sub: "u_1", email: "tlgimenes@gmail.com" },
      accessToken: "at_stale",
      refreshToken: "rt_xyz",
      expiresAt: nowS - 60,
      createdAt: "2026-05-04T00:00:00.000Z",
    });

    const fetchMock = mock(async () => new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;

    const code = await whoamiCommand({
      dataDir: dir,
      fetch: fetchMock,
      now: () => nowMs,
    });

    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/Not logged in.*decocms auth login/);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test apps/mesh/src/cli/commands/auth/whoami.test.ts`
Expected: two new tests FAIL (`whoamiCommand` doesn't accept `fetch`/`now`, or returns wrong code).

- [ ] **Step 4: Update `whoami.ts`**

Replace the full contents of `apps/mesh/src/cli/commands/auth/whoami.ts` with:

```typescript
import { getValidSession } from "../../lib/get-valid-session";
import { RefreshFailedError } from "../../lib/refresh-session";

export interface WhoamiOptions {
  dataDir: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

export async function whoamiCommand(options: WhoamiOptions): Promise<number> {
  let session;
  try {
    session = await getValidSession({
      dataDir: options.dataDir,
      fetch: options.fetch,
      now: options.now,
    });
  } catch (err) {
    if (err instanceof RefreshFailedError && err.kind === "transient") {
      console.error(
        `Could not refresh session: ${err.message}. Run \`decocms auth login\` to authenticate.`,
      );
      return 1;
    }
    throw err;
  }

  if (!session) {
    console.error("Not logged in. Run `decocms auth login` to authenticate.");
    return 1;
  }
  console.log(`Target: ${session.target}`);
  console.log(`User:   ${session.user.email ?? session.user.sub}`);
  return 0;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test apps/mesh/src/cli/commands/auth/whoami.test.ts`
Expected: 4 tests pass (2 original + 2 new).

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/cli/commands/auth/whoami.ts apps/mesh/src/cli/commands/auth/whoami.test.ts
git commit -m "feat(cli): silently refresh expired sessions in \`auth whoami\`"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full CLI test suite**

Run: `bun test apps/mesh/src/cli`
Expected: all tests pass.

- [ ] **Step 2: Full TypeScript check**

Run: `bun run check 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `bun run lint 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 4: Manual smoke test (optional, requires a running studio)**

```bash
# Wipe any existing session
rm -f ~/deco/session.json

# Should detect missing session and open a browser to sign in.
bun apps/mesh/src/cli.ts link --port 5174
```
Expected: prints `Not logged in — opening browser to sign in to Link.`, browser opens, after sign-in the link daemon starts.

```bash
# Should be silent — no browser, just reports identity.
bun apps/mesh/src/cli.ts auth whoami
```
Expected: prints `Target:` and `User:` lines.

- [ ] **Step 5: Optional cleanup commit if anything was reformatted**

```bash
git status
# If clean, nothing to do.
# Otherwise:
git add -A
git commit -m "chore: format after auto-login work"
```

---

## Notes on testing strategy

Per `CLAUDE.md`, this repo uses two test tiers:
- **Unit (`bun test`):** pure logic, no network, no DB, no real fetch. All helpers in this plan are tested via injectable `fetch` mocks. No `vi.mock` / `mock.module` is used.
- **E2E (Playwright):** for cross-process behavior. The link-daemon's actual WebSocket auth is out of scope for this PR's unit tests; the daemon-startup happy path stays covered by existing integration tests (which now pass `session` explicitly).

The smoke test in Task 8 Step 4 is intentionally manual — it requires the studio server and a real browser, neither of which the unit suite can exercise.
