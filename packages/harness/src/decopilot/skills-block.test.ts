import { describe, expect, test } from "bun:test";
import { buildSkillsBlock, type SkillsBlockEntry } from "./skills-block";

const entry = (
  id: string,
  description: string | null,
  source = "public:core",
): SkillsBlockEntry => ({ id, description, source });

describe("buildSkillsBlock", () => {
  test("returns null when there are no skills", () => {
    expect(buildSkillsBlock([])).toBeNull();
  });

  test("emits CSV catalog with id,description,source header", () => {
    const result = buildSkillsBlock([
      entry("core/slides", "Create decks"),
      entry("home/onboarding", "Org onboarding", "home"),
    ]);
    expect(result).toContain("<available-skills>");
    expect(result).toContain("id,description,source");
    expect(result).toContain("core/slides,Create decks,public:core");
    expect(result).toContain("home/onboarding,Org onboarding,home");
  });

  test("includes <skills-usage> with skill tool + already-loaded warning", () => {
    const result = buildSkillsBlock([entry("core/slides", "Create decks")]);
    expect(result).toContain("<skills-usage>");
    // lowercase to match the registered tool name (`skill`, not `Skill`).
    expect(result).toContain("skill({ id })");
    expect(result).toContain("WARNING");
    expect(result).toContain("already appears");
  });

  test("renders empty description as an empty CSV column", () => {
    const result = buildSkillsBlock([entry("core/bare", null)]);
    expect(result).toContain("\ncore/bare,,public:core\n");
  });

  test("escapes CSV-special characters per RFC 4180", () => {
    const result = buildSkillsBlock([entry("core/x", `desc, with "quote"`)]);
    expect(result).toContain(`core/x,"desc, with ""quote""",public:core`);
  });

  test("truncates long descriptions and flattens whitespace", () => {
    const long = "a".repeat(250);
    const result = buildSkillsBlock([entry("core/x", `multi\n  line ${long}`)]);
    // newline collapsed → field not quoted; ellipsis appended; capped at 200.
    const row = result?.split("\n").find((l) => l.startsWith("core/x,"));
    expect(row).toBeDefined();
    expect(row).toContain("multi line");
    expect(row).toContain("…");
    expect(row?.length).toBeLessThan(220);
  });

  test("calls out user-configured skills by id (also listed as rows)", () => {
    const result = buildSkillsBlock(
      [entry("core/slides", "decks"), entry("home/onb", "onboarding", "home")],
      ["home/onb"],
    );
    expect(result).toContain(
      "The user explicitly configured these skills for this agent",
    );
    expect(result).toContain("home/onb");
    // still a normal catalog row, not a separate listing.
    expect(result).toContain("home/onb,onboarding,home");
  });

  test("ignores configured ids not present in the catalog; no callout when none", () => {
    const result = buildSkillsBlock(
      [entry("core/slides", "decks")],
      ["ghost/x"],
    );
    expect(result).not.toContain("explicitly configured");
  });
});
