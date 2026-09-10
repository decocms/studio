import { describe, expect, test } from "bun:test";
import { notifyOrgFsChange, orgFsChangeSubjects } from "./org-fs-notify";
import { setSkillCatalogCache } from "./skill-catalog-cache";

describe("org-fs NATS compatibility subjects", () => {
  test("returns the canonical subject first and its legacy alias second", () => {
    expect(orgFsChangeSubjects("org-1", "home")).toEqual([
      "studio.org-fs.changes.org-1.home",
      "mesh.org-fs.changes.org-1.home",
    ]);
  });

  test("rejects unsafe NATS subject tokens", () => {
    expect(orgFsChangeSubjects("org.with.dot", "home")).toEqual([]);
    expect(orgFsChangeSubjects("org-1", "volume.*")).toEqual([]);
  });

  test("publishes a wake-up to both subjects during rolling upgrades", async () => {
    const published: string[] = [];
    const connection = {
      publish: (subject: string) => published.push(subject),
    };

    await notifyOrgFsChange(connection as never, "org-1", "home");

    expect(published).toEqual([
      "studio.org-fs.changes.org-1.home",
      "mesh.org-fs.changes.org-1.home",
    ]);
  });

  test("invalidates the org's skill catalog even with no NATS connection", async () => {
    const invalidated: string[] = [];
    setSkillCatalogCache({
      get: async () => ({ catalog: null }),
      set: async () => {},
      invalidate: async (orgId) => {
        invalidated.push(orgId);
      },
      teardown: () => {},
    });

    try {
      // A write still has to drop the catalog when the wake-up can't be sent —
      // the cache is shared across replicas, so a live NATS link is not what
      // makes the stale build reachable.
      await notifyOrgFsChange(null, "org-1", "home");
      expect(invalidated).toEqual(["org-1"]);
    } finally {
      setSkillCatalogCache(null);
    }
  });
});
