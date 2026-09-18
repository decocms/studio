/** Set before any import reaches getSettings(), which freezes on first access. */
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { sql } from "kysely";
import { auth } from "../../auth";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import { getSettings, setGlobalSettings } from "../../settings";
import { createApp } from "../app";

if (!getSettings().encryptionKey) {
  setGlobalSettings({
    ...getSettings(),
    encryptionKey: process.env.ENCRYPTION_KEY!,
  });
}

/**
 * Black-box coverage of the service-token repository lane: who may call it,
 * whose repositories they may name, and what a malformed body does. The
 * provider itself is deliberately out of frame — a 200 from `/tree` would be
 * asserting GitHub's API rather than this route.
 */
const url = (org: string, path: string) =>
  `http://test/api/${org}/internal/repositories/${path}`;

const post = (org: string, path: string, token: string | null, body: unknown) =>
  new Request(url(org, path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** Orgs whose id ≠ slug, so the tests prove the worker can resolve by ID. */
const ORG = "org_repo_reads";
const OTHER_ORG = "org_repo_other";

describe("Internal Repository Routes", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  const prevServiceToken = process.env.VAULT_SERVICE_TOKEN;

  beforeEach(async () => {
    process.env.VAULT_SERVICE_TOKEN = "svc-secret";
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);

    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "verifyApiKey").mockResolvedValue({
      valid: false,
      error: { message: "invalid api key" },
      key: null,
    } as never);

    const now = new Date().toISOString();
    for (const [id, slug] of [
      [ORG, "repo-reads-org"],
      [OTHER_ORG, "repo-other-org"],
    ]) {
      await sql`
        INSERT INTO "organization" (id, name, slug, "createdAt")
        VALUES (${id}, ${id}, ${slug}, ${now})
        ON CONFLICT (id) DO NOTHING
      `.execute(database.db);
    }

    /** A revoked GitLab account, plus the repository linked to it. */
    await sql`
      INSERT INTO git_provider_accounts
        (id, organization_id, type, host, auth_kind, external_account_id, login, status)
      VALUES
        ('acct_revoked', ${ORG}, 'gitlab', 'gitlab.example.dev', 'oauth', '9001', 'acme-bot', 'revoked')
    `.execute(database.db);

    await sql`
      INSERT INTO repositories
        (id, organization_id, account_id, provider, host, path, web_url, default_branch)
      VALUES
        ('repo_linked', ${ORG}, 'acct_revoked', 'gitlab', 'gitlab.example.dev',
         'group/sub/project', 'https://gitlab.example.dev/group/sub/project', 'main'),
        ('repo_anonymous', ${ORG}, NULL, 'github', 'github.com',
         'acme/storefront', 'https://github.com/acme/storefront', NULL),
        ('repo_other_org', ${OTHER_ORG}, NULL, 'github', 'github.com',
         'other/private', 'https://github.com/other/private', NULL)
    `.execute(database.db);

    app = await createApp({ database, disableNats: true });
  });

  afterEach(async () => {
    if (prevServiceToken === undefined) {
      delete process.env.VAULT_SERVICE_TOKEN;
    } else {
      process.env.VAULT_SERVICE_TOKEN = prevServiceToken;
    }
    vi.restoreAllMocks();
    if (app) await app.shutdown();
    if (database) await closeTestPgDatabase(database);
  });

  it("rejects requests without the service token", async () => {
    const noToken = await app.fetch(
      post(ORG, "resolve", null, { repository_id: "repo_anonymous" }),
    );
    expect(noToken.status).toBe(401);

    const wrongToken = await app.fetch(
      post(ORG, "resolve", "not-it", { repository_id: "repo_anonymous" }),
    );
    expect(wrongToken.status).toBe(401);
  });

  it("rejects an unauthenticated read on every repository-scoped route", async () => {
    for (const route of [
      "tree",
      "file",
      "search",
      "change-requests",
      "commits",
    ]) {
      const res = await app.fetch(
        post(ORG, `repo_anonymous/${route}`, null, {}),
      );
      expect(res.status).toBe(401);
    }
  });

  it("resolves a repository by id, reporting an anonymous row as unusable", async () => {
    const res = await app.fetch(
      post(ORG, "resolve", "svc-secret", { repository_id: "repo_anonymous" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      repository: {
        repository_id: "repo_anonymous",
        provider: "github",
        host: "github.com",
        path: "acme/storefront",
        default_branch: null,
        web_url: "https://github.com/acme/storefront",
      },
      usable: false,
      reason: "no_account",
    });
  });

  it("resolves by identity, on a self-managed host with a nested namespace", async () => {
    const res = await app.fetch(
      post(ORG, "resolve", "svc-secret", {
        ref: {
          provider: "gitlab",
          host: "gitlab.example.dev",
          path: "group/sub/project",
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repository: { repository_id: string };
      usable: boolean;
      reason: string;
    };
    expect(body.repository.repository_id).toBe("repo_linked");
    // Revoked is durable, so the caller may act on it.
    expect(body).toMatchObject({ usable: false, reason: "account_revoked" });
  });

  it("does not resolve an identity whose provider disagrees with the stored row", async () => {
    const res = await app.fetch(
      post(ORG, "resolve", "svc-secret", {
        ref: {
          provider: "github",
          host: "gitlab.example.dev",
          path: "group/sub/project",
        },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("answers 404 for an identity this org has not linked", async () => {
    const res = await app.fetch(
      post(ORG, "resolve", "svc-secret", {
        ref: { provider: "github", host: "github.com", path: "never/linked" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("never reads another org's repository, by id or by identity", async () => {
    const byId = await app.fetch(
      post(ORG, "resolve", "svc-secret", { repository_id: "repo_other_org" }),
    );
    expect(byId.status).toBe(404);

    const byRef = await app.fetch(
      post(ORG, "resolve", "svc-secret", {
        ref: { provider: "github", host: "github.com", path: "other/private" },
      }),
    );
    expect(byRef.status).toBe(404);

    for (const route of ["tree", "file", "search", "commits"]) {
      const res = await app.fetch(
        post(ORG, `repo_other_org/${route}`, "svc-secret", {
          path: "README.md",
          since: "2026-01-01T00:00:00Z",
          query: "checkout",
        }),
      );
      expect(res.status).toBe(404);
    }
  });

  it("refuses a resolve body that names neither an id nor an identity", async () => {
    const res = await app.fetch(post(ORG, "resolve", "svc-secret", {}));
    expect(res.status).toBe(422);
  });

  it("refuses a body that misses a required field or exceeds a cap", async () => {
    const cases: Array<[string, unknown]> = [
      ["repo_anonymous/file", {}],
      ["repo_anonymous/file", { path: "README.md", max_bytes: 10_000_000 }],
      ["repo_anonymous/tree", { max_entries: 999_999 }],
      ["repo_anonymous/search", { query: "" }],
      ["repo_anonymous/change-requests", { state: "abandoned" }],
      ["repo_anonymous/change-requests", { state: "merged", limit: 5000 }],
      ["repo_anonymous/commits", {}],
      ["repo_anonymous/commits", { since: "2026-01-01T00:00:00Z", limit: 0 }],
    ];
    for (const [path, body] of cases) {
      const res = await app.fetch(post(ORG, path, "svc-secret", body));
      expect(res.status).toBe(422);
    }
  });

  it("checks the repository before the body, so a foreign id never sees a schema error", async () => {
    const res = await app.fetch(
      post(ORG, "repo_other_org/file", "svc-secret", { nonsense: true }),
    );
    expect(res.status).toBe(404);
  });

  it("surfaces a dead credential as a gateway error, not as 'no repository'", async () => {
    /**
     * `repo_anonymous` has no account, so the insights factory refuses to mint.
     * A 404 would read as "this repository is gone" and downgrade a card that
     * is merely waiting for someone to link an account.
     */
    const res = await app.fetch(
      post(ORG, "repo_anonymous/tree", "svc-secret", {}),
    );
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: "provider_auth_failed",
    });
  });
});
