import { describe, expect, test } from "bun:test";
import {
  ancestorsOf,
  basenameOf,
  fsObjectKey,
  fsVolumePrefix,
  isValidVolume,
  normalizeFsPath,
  parentOf,
} from "./org-fs-path";

describe("normalizeFsPath", () => {
  test("strips leading/trailing slashes and dot segments", () => {
    expect(normalizeFsPath("/a/b/")).toBe("a/b");
    expect(normalizeFsPath("./a/./b")).toBe("a/b");
    expect(normalizeFsPath("a//b")).toBe("a/b");
  });

  test("resolves traversal safely (cannot escape root)", () => {
    expect(normalizeFsPath("../../etc/passwd")).toBe("etc/passwd");
    expect(normalizeFsPath("a/../../b")).toBe("b");
    expect(normalizeFsPath("a/b/../c")).toBe("a/c");
  });

  test("normalizes backslashes and decodes percent-encoding", () => {
    expect(normalizeFsPath("a\\b")).toBe("a/b");
    expect(normalizeFsPath("a%2Fb")).toBe("a/b");
  });

  test("root variants collapse to empty string", () => {
    expect(normalizeFsPath("")).toBe("");
    expect(normalizeFsPath("/")).toBe("");
    expect(normalizeFsPath(".")).toBe("");
  });
});

describe("parentOf / basenameOf", () => {
  test("top-level entries have empty parent", () => {
    expect(parentOf("file.txt")).toBe("");
    expect(basenameOf("file.txt")).toBe("file.txt");
  });

  test("nested entries split on the last slash", () => {
    expect(parentOf("a/b/c.txt")).toBe("a/b");
    expect(basenameOf("a/b/c.txt")).toBe("c.txt");
  });
});

describe("ancestorsOf", () => {
  test("returns top-down dirs excluding root and self", () => {
    expect(ancestorsOf("a/b/c.txt")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("a/file.txt")).toEqual(["a"]);
    expect(ancestorsOf("file.txt")).toEqual([]);
  });
});

describe("key helpers", () => {
  test("object key and volume prefix are namespaced", () => {
    expect(fsObjectKey("skills", "a/b.md")).toBe("_fs/skills/a/b.md");
    expect(fsVolumePrefix("skills")).toBe("_fs/skills/");
  });
});

describe("isValidVolume", () => {
  test("accepts safe names, rejects separators and emptiness", () => {
    expect(isValidVolume("org-skills")).toBe(true);
    expect(isValidVolume("v1.0_test")).toBe(true);
    expect(isValidVolume("")).toBe(false);
    expect(isValidVolume("a/b")).toBe(false);
    expect(isValidVolume("../x")).toBe(false);
  });

  test("rejects '.' and '..' — the regex alone would accept them and let fsObjectKey escape the _fs/ namespace once sanitizeKey collapses the dot segments", () => {
    expect(isValidVolume(".")).toBe(false);
    expect(isValidVolume("..")).toBe(false);
  });
});
