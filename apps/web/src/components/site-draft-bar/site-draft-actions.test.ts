import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The site editor, Experiments and Calendar edit the same draft, so they wear
 * the same bar (environment and Publish): one component, mounted as each
 * route's `actions`, never a copy.
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
      expect(source).toContain("<SiteDraftActions />");
      expect(source).not.toContain("<CmsHeaderActions");
      expect(source).not.toContain("<ChatModeRow");
    });
  }
});
