import { describe, expect, test } from "bun:test";
import { buildPromptsBlock, type PromptsBlockEntry } from "./prompts-block";

const entry = (
  name: string,
  description: string | null,
  args: Array<{ name: string; required?: boolean }> = [],
): PromptsBlockEntry => ({ name, description, arguments: args });

describe("buildPromptsBlock", () => {
  test("returns null when there are no prompts", () => {
    expect(buildPromptsBlock([])).toBeNull();
  });

  test("emits CSV catalog with name,description,args header", () => {
    const result = buildPromptsBlock([
      entry("hello", "Greets the user", [{ name: "name", required: true }]),
      entry("plain", "Plain", []),
    ]);
    expect(result).toContain("<available-prompts>");
    expect(result).toContain("name,description,args");
    expect(result).toContain("hello,Greets the user,name (required)");
    expect(result).toContain("plain,Plain,");
  });

  test("joins multiple args with `; ` and flags required", () => {
    const result = buildPromptsBlock([
      entry("multi", "desc", [
        { name: "a", required: true },
        { name: "b" },
        { name: "c", required: true },
      ]),
    ]);
    expect(result).toContain(`multi,desc,"a (required); b; c (required)"`);
  });

  test("includes <prompts-usage> with the already-loaded warning", () => {
    const result = buildPromptsBlock([entry("hello", "Greets the user")]);
    expect(result).toContain("<prompts-usage>");
    expect(result).toContain("read_prompt");
    expect(result).toContain("WARNING");
    expect(result).toContain("already appears");
  });

  test("renders empty description and args fields as empty CSV columns", () => {
    const result = buildPromptsBlock([entry("bare", null)]);
    expect(result).toContain("\nbare,,\n");
  });

  test("escapes CSV-special characters in name/description per RFC 4180", () => {
    const result = buildPromptsBlock([
      entry("with,comma", `desc "quoted"`),
      entry("multi\nline", "ok"),
    ]);
    expect(result).toContain(`"with,comma","desc ""quoted""",`);
    expect(result).toContain(`"multi\nline",ok,`);
  });
});
