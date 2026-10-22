import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The site editor, Experiments and Calendar edit the same draft, so on a
 * Blocks v8 site they wear the same bar (environment and Publish): one
 * component, mounted as each route's `actions`. The site editor keeps main's
 * own bar on any other site (PO decision: gated to v8).
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

  test("the site editor shows the shared bar on v8 only, main's elsewhere", () => {
    const source = readFileSync(join(routes, "agent-site-editor.tsx"), "utf8");
    expect(source).toMatch(
      /editsBlocksDraft\(useMainSchemaV8\(session\?\.virtualMcpId\)\) \? \(\s*<SiteDraftActions \/>\s*\) : \(\s*<V7SiteEditorActions \/>\s*\)/,
    );
    expect(source).toContain("actions={<SiteEditorActions />}");
  });
});
