import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The site editor, Experiments and Calendar edit the same draft, so on a
 * Blocks v8 site they wear the same bar (environment and Publish): one
 * component, mounted as each route's `actions`. On any other site the site
 * editor's bar shows exactly main's parts (`siteDraftBarParts`).
 */
describe("the site's draft bar", () => {
  const routes = join(import.meta.dir, "../../routes/workspace");
  for (const file of [
    "agent-site-editor.tsx",
    "agent-experiments.tsx",
    "agent-calendar.tsx",
  ]) {
    test(`${file} mounts the shared SiteDraftActions`, () => {
      const source = readFileSync(join(routes, file), "utf8");
      expect(source).toContain(
        'import { SiteDraftActions } from "@/components/site-draft-bar/site-draft-actions";',
      );
      expect(source).toMatch(
        file === "agent-site-editor.tsx"
          ? /<SiteDraftActions \/>/
          : /<SiteDraftActions blocksOnly \/>/,
      );
      if (file !== "agent-site-editor.tsx") {
        expect(source).not.toContain("<CmsHeaderActions");
        expect(source).not.toContain("<ChatModeRow");
      }
    });
  }

  test("the site editor mounts the bar on every site, with no v7/v8 switch", () => {
    // `siteDraftBarParts` holds main's rules (site-draft-bar-parts.test.ts),
    // so a v7 site gets main's bar from the same component, and a v8 site's
    // bar never remounts (closing an open Publish panel) when main answers.
    const source = readFileSync(join(routes, "agent-site-editor.tsx"), "utf8");
    expect(source).toContain("actions={<SiteDraftActions />}");
    expect(source).not.toContain("useMainSchemaV8");
    expect(source).not.toContain("<CmsHeaderActions");
    expect(source).not.toContain("<ChatModeRow");
  });
});
