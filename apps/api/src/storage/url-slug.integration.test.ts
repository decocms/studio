import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { CredentialVault } from "../encryption/credential-vault";
import { ConnectionStorage } from "./connection";
import { UrlSlugTakenError } from "./url-slug";
import { VirtualMCPStorage } from "./virtual";

describe("connection url_slug", () => {
  let database: StudioDatabase;
  let connections: ConnectionStorage;
  let projects: VirtualMCPStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    connections = new ConnectionStorage(
      database.db,
      new CredentialVault(CredentialVault.generateKey()),
    );
    projects = new VirtualMCPStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const createProject = (organizationId: string, title: string) =>
    projects.create(organizationId, "user_123", {
      title,
      status: "active",
      pinned: false,
      connections: [],
    });

  const createConnection = (organizationId: string, title: string) =>
    connections.create({
      organization_id: organizationId,
      created_by: "user_123",
      title,
      connection_type: "HTTP",
      connection_url: "https://example.com/mcp",
    });

  it("derives a slug from the title and suffixes duplicates", async () => {
    const first = await createProject("org_123", "Marketing Site");
    const second = await createProject("org_123", "Marketing Site");
    expect(first.url_slug).toBe("marketing-site");
    expect(second.url_slug).toBe("marketing-site-2");
  });

  it("falls back when the title has no usable characters", async () => {
    const project = await createProject("org_123", "🚀");
    expect(project.url_slug).toBe("project");
    const connection = await createConnection("org_123", "✨");
    expect(connection.url_slug).toBe("examplecom-mcp");
  });

  it("allocates distinct slugs for concurrent creates", async () => {
    const created = await Promise.all(
      Array.from({ length: 4 }, () => createConnection("org_123", "Rituals")),
    );
    const slugs = created.map((c) => c.url_slug);
    expect(new Set(slugs).size).toBe(4);
    expect(slugs).toContain("rituals");
  });

  it("scopes slugs and resolution to the organization", async () => {
    const a = await createProject("org_456", "Shared Name");
    const b = await createProject("org_1", "Shared Name");
    expect(a.url_slug).toBe("shared-name");
    expect(b.url_slug).toBe("shared-name");
    const resolved = await connections.resolveUrlSlug(
      "org_1",
      "shared-name",
      "project",
    );
    expect(resolved?.id).toBe(b.id);
    expect(
      await connections.resolveUrlSlug("org_1", "shared-name", "connection"),
    ).toBeNull();
  });

  it("keeps the slug across renames", async () => {
    const project = await createProject("org_123", "Before Rename");
    const renamed = await projects.update(project.id, "user_123", {
      title: "After Rename",
    });
    expect(renamed.url_slug).toBe("before-rename");
  });

  it("redirects an old slug after an edit and lets another row claim it", async () => {
    const project = await createProject("org_123", "Old Name");
    const edited = await projects.update(project.id, "user_123", {
      url_slug: "new-name",
    });
    expect(edited.url_slug).toBe("new-name");
    expect(
      await connections.resolveUrlSlug("org_123", "old-name", "project"),
    ).toEqual({ id: project.id, canonicalSlug: "new-name" });

    // A new row avoids the alias by default…
    const other = await createProject("org_123", "Old Name");
    expect(other.url_slug).toBe("old-name-2");

    // …but an explicit edit takes it over.
    await projects.update(other.id, "user_123", { url_slug: "old-name" });
    expect(
      await connections.resolveUrlSlug("org_123", "old-name", "project"),
    ).toEqual({ id: other.id, canonicalSlug: "old-name" });
  });

  it("rejects a slug another row currently uses, and invalid slugs", async () => {
    const a = await createConnection("org_123", "Taken A");
    await createConnection("org_123", "Taken B");
    await expect(
      connections.update(a.id, { url_slug: "taken-b" }),
    ).rejects.toBeInstanceOf(UrlSlugTakenError);
    for (const bad of ["settings", "Has Caps", "conn_abc", "a", "x--y"]) {
      await expect(
        connections.update(a.id, { url_slug: bad }),
      ).rejects.toThrow();
    }
  });

  it("deletes aliases with their row", async () => {
    const connection = await createConnection("org_123", "Short Lived");
    await connections.update(connection.id, { url_slug: "renamed-lived" });
    await connections.delete(connection.id);
    const aliases = await database.db
      .selectFrom("connection_slug_aliases")
      .selectAll()
      .where("connection_id", "=", connection.id)
      .execute();
    expect(aliases).toEqual([]);
  });
});
