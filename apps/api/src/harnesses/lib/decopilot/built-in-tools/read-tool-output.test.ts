import { describe, expect, it } from "bun:test";
import {
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TOOL_OUTPUTS,
  createToolOutputMap,
} from "./read-tool-output";

describe("createToolOutputMap", () => {
  it("stays under the cap by evicting the oldest entry", () => {
    const map = createToolOutputMap();
    for (let i = 0; i < MAX_TOOL_OUTPUTS + 10; i++) {
      map.set(`call_${i}`, `output ${i}`);
    }
    expect(map.size).toBe(MAX_TOOL_OUTPUTS);
    expect(map.has("call_0")).toBe(false);
    expect(map.has(`call_${MAX_TOOL_OUTPUTS + 9}`)).toBe(true);
  });

  it("re-setting an existing key doesn't evict anything", () => {
    const map = createToolOutputMap();
    for (let i = 0; i < MAX_TOOL_OUTPUTS; i++) {
      map.set(`call_${i}`, `output ${i}`);
    }
    map.set("call_0", "updated");
    expect(map.size).toBe(MAX_TOOL_OUTPUTS);
    expect(map.get("call_0")).toBe("updated");
  });

  it("trims a single oversized value instead of storing it whole", () => {
    const map = createToolOutputMap();
    const huge = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 1000);
    map.set("call_0", huge);
    expect(map.get("call_0")?.length).toBe(MAX_TOOL_OUTPUT_CHARS);
  });
});
