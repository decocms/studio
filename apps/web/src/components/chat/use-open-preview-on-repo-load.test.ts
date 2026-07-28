import { describe, expect, it } from "bun:test";
import { countLoadedRepos } from "./use-open-preview-on-repo-load";

describe("countLoadedRepos", () => {
  const load = (over: Record<string, unknown> = {}) => ({
    type: "tool-load_repo",
    state: "output-available",
    output: { success: true },
    ...over,
  });

  it("counts each successful load (a switch is a second signal)", () => {
    expect(countLoadedRepos([])).toBe(0);
    expect(countLoadedRepos([{ parts: [load()] }])).toBe(1);
    expect(countLoadedRepos([{ parts: [load()] }, { parts: [load()] }])).toBe(
      2,
    );
  });

  it("ignores in-flight, failed and unrelated parts", () => {
    expect(
      countLoadedRepos([
        { parts: [load({ state: "input-available" })] },
        { parts: [load({ output: { success: false } })] },
        { parts: [load({ output: undefined })] },
        { parts: [{ type: "tool-bash", state: "output-available" }] },
        { parts: [{ type: "text", text: "load_repo" }] },
        {},
      ]),
    ).toBe(0);
  });
});
