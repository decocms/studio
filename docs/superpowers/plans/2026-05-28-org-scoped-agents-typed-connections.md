# Org-scoped agents + typed connections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agents always org-scoped, give every non-registry connection a stable derived `app_id`, and forbid private connections from being concrete children of agents — so private connections can only be attached as per-caller slots.

**Architecture:** A pure `deriveAppId` helper produces a deterministic `app_id` (`url:`/`stdio:`/`npx:` prefixes double as a "synthetic" marker). It is invoked at the `ConnectionStorage` create/update choke point and by a one-time migration that also flips all existing connections to `access='org'`. Agent creation hard-codes `access='org'`. The `COLLECTION_VIRTUAL_MCP` create/update handlers reject `access='user'` connections in their concrete-children array.

**Tech Stack:** TypeScript, Kysely (Postgres), Bun test runner, Zod. Spec: `docs/superpowers/specs/2026-05-28-org-scoped-agents-typed-connections-design.md`.

---

## File Structure

- **Create** `apps/mesh/src/storage/derive-app-id.ts` — pure `deriveAppId` helper + canonicalization. One responsibility: turn a connection's transport details into a stable `app_id`.
- **Create** `apps/mesh/src/storage/derive-app-id.test.ts` — pure unit tests for the helper.
- **Modify** `apps/mesh/src/storage/connection.ts` — call `deriveAppId` in `create`/`update`; add a duplicate-key → friendly-error wrapper.
- **Create** `apps/mesh/src/storage/derive-app-id-fill.integration.test.ts` — storage-level tests for the create/update fill + friendly error.
- **Modify** `apps/mesh/src/storage/virtual.ts` — `create` sets `access: 'org'`.
- **Modify** `apps/mesh/src/storage/virtual.integration.test.ts` — assert agents are created org-scoped.
- **Create** `apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.ts` — shared validation helper.
- **Create** `apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.integration.test.ts` — its tests.
- **Modify** `apps/mesh/src/tools/virtual/create.ts` + `apps/mesh/src/tools/virtual/update.ts` — wire the validation in.
- **Create** `apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.ts` — the one-time migration (with exported, testable helpers).
- **Create** `apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.integration.test.ts` — tests the exported migration helpers.
- **Modify** `apps/mesh/migrations/index.ts` — register migration 098.

---

## Task 1: `deriveAppId` helper

**Files:**
- Create: `apps/mesh/src/storage/derive-app-id.ts`
- Test: `apps/mesh/src/storage/derive-app-id.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/storage/derive-app-id.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { deriveAppId, isSyntheticAppId } from "./derive-app-id";

describe("deriveAppId", () => {
  it("returns null for VIRTUAL agents", () => {
    expect(
      deriveAppId({ connection_type: "VIRTUAL", connection_url: "virtual://x" }),
    ).toBeNull();
  });

  it("preserves a real registry app_id unchanged", () => {
    expect(
      deriveAppId({
        connection_type: "HTTP",
        connection_url: "https://api.github.com/mcp",
        app_id: "deco/mcp-github",
      }),
    ).toBe("deco/mcp-github");
  });

  it("derives url: from an HTTP url, dropping query and trailing slash, lowercasing host", () => {
    expect(
      deriveAppId({
        connection_type: "HTTP",
        connection_url: "https://API.Example.com:443/mcp/?token=abc",
      }),
    ).toBe("url:api.example.com/mcp");
  });

  it("keeps distinct paths distinct", () => {
    expect(
      deriveAppId({ connection_type: "HTTP", connection_url: "https://x.com/a/mcp" }),
    ).toBe("url:x.com/a/mcp");
    expect(
      deriveAppId({ connection_type: "HTTP", connection_url: "https://x.com/b/mcp" }),
    ).toBe("url:x.com/b/mcp");
  });

  it("keeps a non-default port", () => {
    expect(
      deriveAppId({ connection_type: "HTTP", connection_url: "http://x.com:8080/mcp" }),
    ).toBe("url:x.com:8080/mcp");
  });

  it("derives npx: from an npx STDIO connection", () => {
    expect(
      deriveAppId({
        connection_type: "STDIO",
        connection_headers: { command: "npx", args: ["-y", "@deco/foo"] },
      }),
    ).toBe("npx:@deco/foo");
  });

  it("derives stdio: from a generic STDIO command", () => {
    expect(
      deriveAppId({
        connection_type: "STDIO",
        connection_headers: { command: "node", args: ["server.js"] },
      }),
    ).toBe("stdio:node-server-js");
  });

  it("parses connection_headers when given as a JSON string", () => {
    expect(
      deriveAppId({
        connection_type: "STDIO",
        connection_headers: JSON.stringify({ command: "npx", args: ["pkg"] }),
      }),
    ).toBe("npx:pkg");
  });

  it("re-derives when the current app_id is synthetic", () => {
    expect(
      deriveAppId({
        connection_type: "HTTP",
        connection_url: "https://new.com/mcp",
        app_id: "url:old.com/mcp",
      }),
    ).toBe("url:new.com/mcp");
  });

  it("returns null when nothing is derivable and no app_id exists", () => {
    expect(deriveAppId({ connection_type: "STDIO" })).toBeNull();
  });

  it("isSyntheticAppId recognizes synthetic prefixes only", () => {
    expect(isSyntheticAppId("url:x.com")).toBe(true);
    expect(isSyntheticAppId("stdio:node")).toBe(true);
    expect(isSyntheticAppId("npx:pkg")).toBe(true);
    expect(isSyntheticAppId("deco/mcp-github")).toBe(false);
    expect(isSyntheticAppId(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/storage/derive-app-id.test.ts`
Expected: FAIL — `Cannot find module './derive-app-id'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mesh/src/storage/derive-app-id.ts`:

```typescript
/**
 * Derives a stable, deterministic `app_id` for a connection so that the same
 * service always yields the same id (which is what lets an agent slot resolve
 * to each caller's own connection of that id). Registry connections keep their
 * existing `app_id`; only connections with a null or synthetic `app_id` are
 * (re)derived.
 *
 * Synthetic ids are prefixed `url:` / `stdio:` / `npx:`; the prefix doubles as
 * the marker that distinguishes a derived id (safe to recompute) from a real
 * registry id (never touch).
 */

import {
  type ConnectionParameters,
  isStdioParameters,
} from "../tools/connection/schema";

const SYNTHETIC_PREFIXES = ["url:", "stdio:", "npx:"] as const;

export function isSyntheticAppId(appId: string | null | undefined): boolean {
  return (
    typeof appId === "string" &&
    SYNTHETIC_PREFIXES.some((p) => appId.startsWith(p))
  );
}

export interface DeriveAppIdInput {
  connection_type?: string | null;
  connection_url?: string | null;
  connection_headers?: unknown;
  app_id?: string | null;
}

export function deriveAppId(input: DeriveAppIdInput): string | null {
  // Agents are never a child / slot target.
  if (input.connection_type === "VIRTUAL") return null;

  // Preserve a real registry app_id; only (re)derive null/synthetic ids.
  if (input.app_id && !isSyntheticAppId(input.app_id)) return input.app_id;

  const params = parseHeaders(input.connection_headers);
  if (params && isStdioParameters(params)) {
    return deriveStdioAppId(params);
  }

  if (input.connection_url) {
    const canonical = canonicalizeUrl(input.connection_url);
    if (canonical) return `url:${canonical}`;
  }

  // Nothing derivable — keep whatever was there (or null).
  return input.app_id ?? null;
}

function parseHeaders(headers: unknown): ConnectionParameters | null {
  if (!headers) return null;
  if (typeof headers === "string") {
    try {
      return JSON.parse(headers) as ConnectionParameters;
    } catch {
      return null;
    }
  }
  return headers as ConnectionParameters;
}

function canonicalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  const host = u.hostname.toLowerCase();
  const defaultPort = scheme === "https" ? "443" : scheme === "http" ? "80" : "";
  const port = u.port && u.port !== defaultPort ? `:${u.port}` : "";
  const path = u.pathname.replace(/\/+$/, "");
  return `${host}${port}${path}`;
}

function deriveStdioAppId(params: ConnectionParameters): string {
  const stdio = params as { command?: string; args?: string[] };
  const command = (stdio.command ?? "").trim();
  const args = (stdio.args ?? []).map((a) => a.trim());
  if (command === "npx" || command === "bunx") {
    const pkg = args.find((a) => a.length > 0 && !a.startsWith("-"));
    if (pkg) return `npx:${pkg}`;
  }
  return `stdio:${slug([command, ...args].join(" "))}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/storage/derive-app-id.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/storage/derive-app-id.ts apps/mesh/src/storage/derive-app-id.test.ts
git commit -m "feat(connections): add deriveAppId helper for synthetic app_ids"
```

---

## Task 2: Fill `app_id` on `ConnectionStorage.create`

**Files:**
- Modify: `apps/mesh/src/storage/connection.ts:194-228` (`create`), and add module-level helper
- Test: `apps/mesh/src/storage/derive-app-id-fill.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/storage/derive-app-id-fill.integration.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { MeshDatabase } from "../database";
import { ConnectionStorage } from "./connection";
import { CredentialVault } from "../encryption/credential-vault";

const USER = "user_test";
const ORG = "org_test";

describe("ConnectionStorage — app_id derivation", () => {
  let database: MeshDatabase;
  let storage: ConnectionStorage;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    const vault = new CredentialVault(CredentialVault.generateKey());
    storage = new ConnectionStorage(database.db, vault);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("fills a synthetic app_id on create when none is provided", async () => {
    const conn = await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "custom",
      connection_type: "HTTP",
      connection_url: "https://API.Example.com/mcp/?token=x",
    });
    expect(conn.app_id).toBe("url:api.example.com/mcp");
  });

  it("preserves a registry app_id on create", async () => {
    const conn = await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "gh",
      connection_type: "HTTP",
      connection_url: "https://api.github.com/mcp",
      app_id: "deco/mcp-github",
    });
    expect(conn.app_id).toBe("deco/mcp-github");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/storage/derive-app-id-fill.integration.test.ts`
Expected: FAIL on the first test — `app_id` is `null` (no derivation wired in yet).

- [ ] **Step 3: Implement the create-path fill + friendly-error helper**

In `apps/mesh/src/storage/connection.ts`, add the import near the other storage imports (after line 34's `./ports` import):

```typescript
import { deriveAppId } from "./derive-app-id";
```

Add this module-level function just above the `export class ConnectionStorage` declaration (line 188):

```typescript
/**
 * Translates the Postgres unique-violation on idx_connections_user_app_unique
 * into a user-facing error. Re-throws anything else untouched.
 */
function rethrowDuplicateConnectionError(err: unknown): never {
  const e = err as { code?: string; constraint?: string; message?: string };
  const isDup =
    e?.code === "23505" &&
    (e?.constraint === "idx_connections_user_app_unique" ||
      (e?.message ?? "").includes("idx_connections_user_app_unique"));
  if (isDup) {
    throw new Error(
      "A private connection for this service already exists. Each service can have only one private connection per user.",
    );
  }
  throw err;
}
```

Replace the body of `create` (lines 208-220) so it derives `app_id` and wraps the insert:

```typescript
    const slug = getConnectionSlug(data);
    const serialized = await this.serializeConnection({
      ...data,
      app_id: deriveAppId(data),
      id: data.id ?? id,
      slug,
      status: "active",
      created_at: now,
      updated_at: now,
    });
    try {
      await this.db
        .insertInto("connections")
        .values(serialized as Insertable<Database["connections"]>)
        .execute();
    } catch (err) {
      rethrowDuplicateConnectionError(err);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/storage/derive-app-id-fill.integration.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/storage/connection.ts apps/mesh/src/storage/derive-app-id-fill.integration.test.ts
git commit -m "feat(connections): derive app_id on connection create"
```

---

## Task 3: Re-derive `app_id` on `ConnectionStorage.update`

**Files:**
- Modify: `apps/mesh/src/storage/connection.ts:360-405` (`update`)
- Test: `apps/mesh/src/storage/derive-app-id-fill.integration.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to the existing describe block)**

Add these tests inside the `describe` block in `apps/mesh/src/storage/derive-app-id-fill.integration.test.ts`:

```typescript
  it("re-derives a synthetic app_id when the url changes on update", async () => {
    const conn = await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "custom",
      connection_type: "HTTP",
      connection_url: "https://old.com/mcp",
    });
    expect(conn.app_id).toBe("url:old.com/mcp");

    const updated = await storage.update(conn.id, {
      connection_url: "https://new.com/mcp",
    });
    expect(updated.app_id).toBe("url:new.com/mcp");
  });

  it("never re-derives a real registry app_id on update", async () => {
    const conn = await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "gh",
      connection_type: "HTTP",
      connection_url: "https://api.github.com/mcp",
      app_id: "deco/mcp-github",
    });

    const updated = await storage.update(conn.id, {
      connection_url: "https://api.github.com/v2/mcp",
    });
    expect(updated.app_id).toBe("deco/mcp-github");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/storage/derive-app-id-fill.integration.test.ts`
Expected: FAIL on the re-derive test — `app_id` stays `url:old.com/mcp` (no re-derivation wired in).

- [ ] **Step 3: Implement the update-path re-derivation**

Replace the `update` method body in `apps/mesh/src/storage/connection.ts` (lines 360-405) with:

```typescript
  async update(
    id: string,
    data: Partial<ConnectionEntity>,
  ): Promise<ConnectionEntity> {
    if (Object.keys(data).length === 0) {
      const connection = await this.findById(id, undefined, INTERNAL_VIEWER);
      if (!connection) throw new Error("Connection not found");
      return connection;
    }

    const slugData: Record<string, unknown> = { ...data };

    // Reload existing once if we need it for slug recomputation or app_id
    // re-derivation.
    const needsExisting =
      data.app_name !== undefined ||
      data.connection_url !== undefined ||
      data.title !== undefined ||
      data.connection_headers !== undefined;
    const existing = needsExisting
      ? await this.findById(id, undefined, INTERNAL_VIEWER)
      : null;

    // Recompute slug if any slug-relevant field changed
    if (
      existing &&
      (data.app_name !== undefined ||
        data.connection_url !== undefined ||
        data.title !== undefined)
    ) {
      slugData.slug = getConnectionSlug({
        app_name: data.app_name ?? existing.app_name,
        connection_url: data.connection_url ?? existing.connection_url,
        title: data.title ?? existing.title,
        id,
      });
    }

    // Re-derive app_id when transport details change. deriveAppId preserves a
    // real registry app_id and only recomputes null/synthetic ids.
    if (
      existing &&
      (data.connection_url !== undefined ||
        data.connection_headers !== undefined)
    ) {
      slugData.app_id = deriveAppId({
        connection_type: data.connection_type ?? existing.connection_type,
        connection_url: data.connection_url ?? existing.connection_url,
        connection_headers:
          data.connection_headers ?? existing.connection_headers,
        app_id: data.app_id ?? existing.app_id,
      });
    }

    const serialized = await this.serializeConnection({
      ...slugData,
      updated_at: new Date().toISOString(),
    });

    try {
      await this.db
        .updateTable("connections")
        .set(serialized)
        .where("id", "=", id)
        .execute();
    } catch (err) {
      rethrowDuplicateConnectionError(err);
    }

    const connection = await this.findById(id, undefined, INTERNAL_VIEWER);
    if (!connection) {
      throw new Error("Connection not found after update");
    }

    return connection;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/storage/derive-app-id-fill.integration.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/storage/connection.ts apps/mesh/src/storage/derive-app-id-fill.integration.test.ts
git commit -m "feat(connections): re-derive synthetic app_id on connection update"
```

---

## Task 4: Friendly error for duplicate private connections

**Files:**
- Test: `apps/mesh/src/storage/derive-app-id-fill.integration.test.ts` (append)
- (Implementation already added in Task 2 via `rethrowDuplicateConnectionError`.)

- [ ] **Step 1: Write the failing test (append to the existing describe block)**

```typescript
  it("rejects a second private connection to the same service for the same user", async () => {
    await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "first",
      connection_type: "HTTP",
      connection_url: "https://dup.com/mcp",
    });

    await expect(
      storage.create({
        organization_id: ORG,
        created_by: USER,
        title: "second",
        connection_type: "HTTP",
        connection_url: "https://dup.com/mcp",
      }),
    ).rejects.toThrow(/only one private connection per user/i);
  });
```

> Note: `storage.create` sets no `access`, so the DB default `'user'` applies; both rows derive `url:dup.com/mcp`, tripping `idx_connections_user_app_unique` (which covers `access='user'` rows).

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test apps/mesh/src/storage/derive-app-id-fill.integration.test.ts`
Expected: PASS — the `rethrowDuplicateConnectionError` wrapper from Task 2 converts the `23505` violation into the friendly message.

- [ ] **Step 3: Commit**

```bash
bun run fmt
git add apps/mesh/src/storage/derive-app-id-fill.integration.test.ts
git commit -m "test(connections): cover duplicate private connection friendly error"
```

---

## Task 5: Agents are always org-scoped

**Files:**
- Modify: `apps/mesh/src/storage/virtual.ts:76-101` (`create` insert)
- Test: `apps/mesh/src/storage/virtual.integration.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/mesh/src/storage/virtual.integration.test.ts` (inside its top-level `describe`; it already imports `sql`, the test-db helpers, and constructs `storage = new VirtualMCPStorage(database.db)` with `USER`/`ORG` constants — reuse them):

```typescript
  it("creates agents as org-scoped regardless of the connections default", async () => {
    const entity = await storage.create(ORG, USER, {
      title: "org agent",
      status: "active",
      pinned: false,
      connections: [],
      slots: [],
    });

    const row = (await sql<{ access: string }>`
      SELECT access FROM connections WHERE id = ${entity.id}
    `.execute(database.db)) as unknown as { rows: { access: string }[] };
    expect(row.rows[0]?.access).toBe("org");
  });
```

> If `virtual.integration.test.ts` does not already import `sql` from `kysely`, add `import { sql } from "kysely";` at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/storage/virtual.integration.test.ts`
Expected: FAIL — `access` is `'user'` (the DB default), not `'org'`.

- [ ] **Step 3: Implement**

In `apps/mesh/src/storage/virtual.ts`, in the `create` method's `.insertInto("connections").values({...})` call, add the `access` field next to `connection_type: "VIRTUAL"` (line 87):

```typescript
        connection_type: "VIRTUAL",
        access: "org",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/storage/virtual.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/storage/virtual.ts apps/mesh/src/storage/virtual.integration.test.ts
git commit -m "feat(agents): create virtual MCPs as org-scoped"
```

---

## Task 6: Reject private connections as concrete children

**Files:**
- Create: `apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.ts`
- Test: `apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.integration.test.ts`
- Modify: `apps/mesh/src/tools/virtual/create.ts`, `apps/mesh/src/tools/virtual/update.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.integration.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import type { MeshDatabase } from "../../database";
import { ConnectionStorage } from "../../storage/connection";
import { CredentialVault } from "../../encryption/credential-vault";
import { assertConcreteChildrenAreOrgScoped } from "./assert-concrete-children-org-scoped";

const USER = "user_test";
const ORG = "org_test";

async function insertConn(
  database: MeshDatabase,
  id: string,
  access: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER}, ${id}, 'HTTP',
      'https://example.com', ${id + "-app"}, ${access},
      'active', ${now}, ${now}
    )
  `.execute(database.db);
}

describe("assertConcreteChildrenAreOrgScoped", () => {
  let database: MeshDatabase;
  let storage: ConnectionStorage;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    await insertConn(database, "conn_org", "org");
    await insertConn(database, "conn_private", "user");
    const vault = new CredentialVault(CredentialVault.generateKey());
    storage = new ConnectionStorage(database.db, vault);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("allows org-scoped concrete children", async () => {
    await expect(
      assertConcreteChildrenAreOrgScoped(
        [{ connection_id: "conn_org" }],
        storage,
        ORG,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a private connection used as a concrete child", async () => {
    await expect(
      assertConcreteChildrenAreOrgScoped(
        [{ connection_id: "conn_private" }],
        storage,
        ORG,
      ),
    ).rejects.toThrow(/private and cannot be added as a concrete child/i);
  });

  it("is a no-op for an empty list", async () => {
    await expect(
      assertConcreteChildrenAreOrgScoped([], storage, ORG),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.integration.test.ts`
Expected: FAIL — `Cannot find module './assert-concrete-children-org-scoped'`.

- [ ] **Step 3: Implement the helper**

Create `apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.ts`:

```typescript
/**
 * Guards the COLLECTION_VIRTUAL_MCP create/update path: a private
 * (access='user') connection must not be hard-bound as a concrete child of an
 * agent, because a concrete child is loaded for every caller regardless of who
 * owns it. Private connections must be attached as typed slots instead, which
 * resolve to each caller's own connection of the same app_id.
 */

import type { ConnectionStoragePort } from "../../storage/ports";
import { INTERNAL_VIEWER } from "../../storage/ports";

export async function assertConcreteChildrenAreOrgScoped(
  connections: { connection_id: string }[],
  connectionStorage: ConnectionStoragePort,
  organizationId: string,
): Promise<void> {
  for (const conn of connections) {
    const c = await connectionStorage.findById(
      conn.connection_id,
      organizationId,
      INTERNAL_VIEWER,
    );
    if (c && c.access === "user") {
      throw new Error(
        `Connection ${conn.connection_id} is private and cannot be added as a concrete child of an agent. Attach it as a slot using its app_id instead.`,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into the create handler**

In `apps/mesh/src/tools/virtual/create.ts`, add the import after the existing imports (after line 16):

```typescript
import { assertConcreteChildrenAreOrgScoped } from "./assert-concrete-children-org-scoped";
```

Then, in the `handler`, immediately after the `userId` null-check block (after line 110) and before building `dataWithIcon`:

```typescript
    await assertConcreteChildrenAreOrgScoped(
      input.data.connections ?? [],
      ctx.storage.connections,
      organization.id,
    );
```

- [ ] **Step 6: Wire into the update handler**

In `apps/mesh/src/tools/virtual/update.ts`, add the import after line 14:

```typescript
import { assertConcreteChildrenAreOrgScoped } from "./assert-concrete-children-org-scoped";
```

Then, in the `handler`, after the existing org-ownership checks (after line 66) and before the metadata merge:

```typescript
    await assertConcreteChildrenAreOrgScoped(
      input.data.connections ?? [],
      ctx.storage.connections,
      organization.id,
    );
```

- [ ] **Step 7: Run type-check + the helper test**

Run: `bun run check && bun test apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.integration.test.ts`
Expected: type-check passes; tests PASS.

- [ ] **Step 8: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.ts apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.integration.test.ts apps/mesh/src/tools/virtual/create.ts apps/mesh/src/tools/virtual/update.ts
git commit -m "feat(agents): reject private connections as concrete children"
```

---

## Task 7: Migration 098 — flip access to org + backfill app_id

**Files:**
- Create: `apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.ts`
- Create: `apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.integration.test.ts`
- Modify: `apps/mesh/migrations/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.integration.test.ts`:

```typescript
/**
 * Integration test for migration 098's exported helpers.
 *
 * The shared integration DB already has 098 applied (and is empty of seeded
 * rows), so we cannot observe the one-time up() backfill against pre-existing
 * data. Instead we test the idempotent, exported helpers directly against
 * seeded rows — they ARE the body of up().
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { MeshDatabase } from "../src/database";
import {
  backfillConnectionAppIds,
  flipAllConnectionsToOrg,
} from "./098-org-scope-connections-and-derive-app-id";

const USER = "user_test";
const ORG = "org_test";

async function insertConn(
  database: MeshDatabase,
  id: string,
  opts: {
    type?: string;
    url?: string | null;
    appId?: string | null;
    access?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER}, ${id}, ${opts.type ?? "HTTP"},
      ${opts.url ?? "https://example.com/mcp"}, ${opts.appId ?? null},
      ${opts.access ?? "org"}, 'active', ${now}, ${now}
    )
  `.execute(database.db);
}

async function read(
  database: MeshDatabase,
  id: string,
): Promise<{ access: string; app_id: string | null }> {
  const result = (await sql<{ access: string; app_id: string | null }>`
    SELECT access, app_id FROM connections WHERE id = ${id}
  `.execute(database.db)) as unknown as {
    rows: { access: string; app_id: string | null }[];
  };
  return result.rows[0]!;
}

describe("migration 098 helpers", () => {
  let database: MeshDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("flips user-scoped connections to org", async () => {
    await insertConn(database, "c_user", { access: "user", appId: "x-app" });
    await flipAllConnectionsToOrg(database.db);
    expect((await read(database, "c_user")).access).toBe("org");
  });

  it("backfills a synthetic app_id for non-VIRTUAL rows with null app_id", async () => {
    await insertConn(database, "c_null", {
      url: "https://svc.com/mcp",
      appId: null,
    });
    await backfillConnectionAppIds(database.db);
    expect((await read(database, "c_null")).app_id).toBe("url:svc.com/mcp");
  });

  it("leaves VIRTUAL rows' app_id null", async () => {
    await insertConn(database, "c_virtual", {
      type: "VIRTUAL",
      url: "virtual://c_virtual",
      appId: null,
    });
    await backfillConnectionAppIds(database.db);
    expect((await read(database, "c_virtual")).app_id).toBeNull();
  });

  it("preserves an existing registry app_id", async () => {
    await insertConn(database, "c_reg", { appId: "deco/mcp-github" });
    await backfillConnectionAppIds(database.db);
    expect((await read(database, "c_reg")).app_id).toBe("deco/mcp-github");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.integration.test.ts`
Expected: FAIL — `Cannot find module './098-org-scope-connections-and-derive-app-id'`.

- [ ] **Step 3: Implement the migration**

Create `apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.ts`:

```typescript
/**
 * Migration 098: org-scope existing connections + backfill synthetic app_ids.
 *
 * Companion to the private-connections model:
 *   1. Reset every existing connection to access='org'. This dissolves the
 *      "private connection hard-bound as a concrete child" case in existing
 *      data — afterward every concrete child is org-scoped and rule-conformant.
 *   2. Backfill a synthetic app_id (deriveAppId) for non-VIRTUAL rows that lack
 *      one. Because every row is org-scoped after step 1, the partial unique
 *      index idx_connections_user_app_unique (WHERE access='user') does not
 *      apply, so duplicate derived ids cannot collide here.
 *
 * The DB default for connections.access stays 'user' (migration 097), so newly
 * created connections remain private-by-default; this migration only resets
 * existing data.
 *
 * Spec: docs/superpowers/specs/2026-05-28-org-scoped-agents-typed-connections-design.md
 */

import { sql, type Kysely } from "kysely";
import { deriveAppId } from "../src/storage/derive-app-id";

interface ConnRow {
  id: string;
  connection_type: string;
  connection_url: string | null;
  connection_headers: string | null;
  app_id: string | null;
}

export async function flipAllConnectionsToOrg(
  db: Kysely<unknown>,
): Promise<void> {
  await sql`UPDATE connections SET access = 'org' WHERE access = 'user'`.execute(
    db,
  );
}

export async function backfillConnectionAppIds(
  db: Kysely<unknown>,
): Promise<void> {
  const result = (await sql<ConnRow>`
    SELECT id, connection_type, connection_url, connection_headers, app_id
    FROM connections
    WHERE app_id IS NULL AND connection_type <> 'VIRTUAL'
  `.execute(db)) as unknown as { rows: ConnRow[] };

  for (const row of result.rows) {
    const appId = deriveAppId({
      connection_type: row.connection_type,
      connection_url: row.connection_url,
      connection_headers: row.connection_headers,
      app_id: row.app_id,
    });
    if (appId) {
      await sql`UPDATE connections SET app_id = ${appId} WHERE id = ${row.id}`.execute(
        db,
      );
    }
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await flipAllConnectionsToOrg(db);
  await backfillConnectionAppIds(db);
}

export async function down(): Promise<void> {
  // One-time data migration: prior null app_ids and per-row access values
  // cannot be reliably reconstructed, so down() is a no-op.
}
```

- [ ] **Step 4: Register the migration**

In `apps/mesh/migrations/index.ts`, add the import next to migration 097's import (after line 98):

```typescript
import * as migration098orgscopeconnectionsandderiveappid from "./098-org-scope-connections-and-derive-app-id.ts";
```

And add the record entry right after the `"097-connection-access-and-slots"` line:

```typescript
  "098-org-scope-connections-and-derive-app-id":
    migration098orgscopeconnectionsandderiveappid,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.ts apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.integration.test.ts apps/mesh/migrations/index.ts
git commit -m "feat(migrations): org-scope connections and backfill synthetic app_ids"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check the whole workspace**

Run: `bun run check`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 3: Run the new + adjacent tests**

Run:
```bash
bun test apps/mesh/src/storage/derive-app-id.test.ts \
  apps/mesh/src/storage/derive-app-id-fill.integration.test.ts \
  apps/mesh/src/storage/virtual.integration.test.ts \
  apps/mesh/src/storage/virtual-slots.integration.test.ts \
  apps/mesh/src/storage/connection-access.integration.test.ts \
  apps/mesh/src/tools/virtual/assert-concrete-children-org-scoped.integration.test.ts \
  apps/mesh/migrations/098-org-scope-connections-and-derive-app-id.integration.test.ts
```
Expected: all PASS.

- [ ] **Step 4: Format check + final commit if anything changed**

```bash
bun run fmt
git status --porcelain
# if anything is unstaged:
git add -A && git commit -m "chore: format org-scoped agents changes"
```

---

## Follow-ups (out of scope for this plan)

- **UI agent editor:** route newly added private connections into `slots[]` (by their `app_id`) instead of `connections[]`, since the create/update tools now reject private concrete children. Flagged in the spec under "Affected areas."
- Consider surfacing the synthetic `app_id` in the connection UI so users understand slot-typing.
