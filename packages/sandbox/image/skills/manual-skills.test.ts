import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillMd } from "@decocms/shared/harness/skill-md";

/**
 * These folders sync into the `core` public set, which mounts read-only into
 * EVERY organization. So a skill added here is a skill every org's every run
 * sees listed in `<available-skills>` — that reach is the point for `slides`
 * and `pdf`, and a bug for a skill whose whole job is to be the text of a
 * prompt a person writes.
 *
 * Forgetting `disable-model-invocation: true` on one of those is silent: the
 * skill works, it is just also advertised to every tenant forever. Hence a
 * test rather than a comment.
 */
const SKILLS_DIR = import.meta.dir;

/** Skills that exist to be INSERTED into a prompt by a person, never
 *  discovered by a model. */
const MANUAL_ONLY = [
  "jira-execute",
  "jira-review",
  "jira-merge",
  "jira-release",
  "jira-validate-production",
  "jira-qa-gate",
  "task-board-setup",
];

function meta(dir: string) {
  return parseSkillMd(readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8"));
}

function skillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name);
}

describe("core public skills", () => {
  // Studio reads a SKILL.md without frontmatter, but Claude Code drops it from a run's skills without a word.
  it("every skill opens with frontmatter naming and describing it", () => {
    const dirs = skillDirs();
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const raw = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
      const head = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "";
      expect({
        dir,
        name: /^name:\s*\S/m.test(head),
        description: /^description:\s*\S/m.test(head),
      }).toEqual({ dir, name: true, description: true });
    }
  });

  it.each(MANUAL_ONLY)("%s is not model-invocable", (dir) => {
    expect(meta(dir).disableModelInvocation).toBe(true);
  });

  // The inverse guard: the flag is opt-in, so a stray one on a skill meant to
  // be found would remove it from every org's catalog just as quietly.
  it("no other skill here opts out of discovery", () => {
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .filter((name) => !MANUAL_ONLY.includes(name));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      expect({ dir, manual: meta(dir).disableModelInvocation }).toEqual({
        dir,
        manual: false,
      });
    }
  });
});
