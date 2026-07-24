import { describe, expect, test } from "bun:test";
import { notifyOrgFsChange, orgFsChangeSubjects } from "./org-fs-notify";

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

  test("publishes a wake-up to both subjects during rolling upgrades", () => {
    const published: string[] = [];
    const connection = {
      publish: (subject: string) => published.push(subject),
    };

    notifyOrgFsChange(connection as never, "org-1", "home");

    expect(published).toEqual([
      "studio.org-fs.changes.org-1.home",
      "mesh.org-fs.changes.org-1.home",
    ]);
  });
});
