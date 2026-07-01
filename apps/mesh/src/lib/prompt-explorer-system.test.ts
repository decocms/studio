import { describe, expect, it } from "bun:test";
import { buildPromptExplorerSystem } from "./prompt-explorer-system";

describe("buildPromptExplorerSystem", () => {
  it("includes the user's name, email, and org", () => {
    const system = buildPromptExplorerSystem({
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      orgName: "Analytical Engines",
    });
    expect(system).toContain("Ada Lovelace");
    expect(system).toContain("ada@example.com");
    expect(system).toContain('"Analytical Engines"');
  });

  it("expands into a concrete, ready-to-use prompt with no bracket placeholders", () => {
    const system = buildPromptExplorerSystem({ userName: "X" });
    // No fill-in blanks: the model makes concrete choices itself.
    expect(system).toMatch(/no placeholders|never use square brackets/i);
    expect(system).toMatch(/ready[- ]to[- ]use|as-is|run immediately/i);
    // Each iteration must grow, not repeat (fixes "v2 identical to v1").
    expect(system).toMatch(/expand/i);
  });

  it("falls back gracefully when identity fields are missing", () => {
    const system = buildPromptExplorerSystem({});
    expect(system).toContain("an unknown user");
    expect(system).not.toContain("in the organization");
  });

  it("uses email alone when name is absent", () => {
    const system = buildPromptExplorerSystem({ userEmail: "only@email.com" });
    expect(system).toContain("only@email.com");
  });

  it("includes a gradual-growth length budget when maxChars is given", () => {
    const system = buildPromptExplorerSystem({ userName: "X", maxChars: 216 });
    expect(system).toContain("216 characters");
    expect(system).toMatch(/gradual/i);
  });

  it("instructs the model to keep the user's voice/person and language", () => {
    const system = buildPromptExplorerSystem({ userName: "X" });
    expect(system).toMatch(/first person/i);
    expect(system).toMatch(/same language/i);
    // Explicitly warns against flipping to second-person address.
    expect(system).toMatch(/You want to|second person/i);
  });

  it("omits the length budget when maxChars is absent or zero", () => {
    expect(buildPromptExplorerSystem({ userName: "X" })).not.toMatch(
      /characters long/,
    );
    expect(
      buildPromptExplorerSystem({ userName: "X", maxChars: 0 }),
    ).not.toMatch(/characters long/);
  });
});
