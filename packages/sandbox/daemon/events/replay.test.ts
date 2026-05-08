import { describe, expect, it } from "bun:test";
import { ReplayBuffer } from "./replay";

describe("ReplayBuffer", () => {
  it("accumulates per-source chunks", () => {
    const buf = new ReplayBuffer(100);
    buf.append("setup", "line 1\n");
    buf.append("setup", "line 2\n");
    expect(buf.read("setup")).toBe("line 1\nline 2\n");
    expect(buf.read("daemon")).toBe("");
  });

  it("trims to the last N bytes", () => {
    const buf = new ReplayBuffer(5);
    buf.append("setup", "hello world");
    expect(buf.read("setup")).toBe("world");
  });

  it("lists current sources", () => {
    const buf = new ReplayBuffer(100);
    buf.append("setup", "x");
    buf.append("daemon", "y");
    expect(buf.sources().sort()).toEqual(["daemon", "setup"]);
  });
});
