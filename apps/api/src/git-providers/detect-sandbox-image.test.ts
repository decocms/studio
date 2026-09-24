import { describe, expect, it } from "bun:test";
import { detectSandboxImage } from "./detect-sandbox-image";
import type { RepoRef } from "@decocms/shared/git-providers";

const repo: RepoRef = {
  provider: "github",
  host: "github.com",
  path: "acme/mobile-app",
};

function repoWith(files: string[]) {
  const reads: string[] = [];
  return {
    reads,
    client: {
      readFile: async (_repo: RepoRef, path: string) => {
        reads.push(path);
        return files.includes(path) ? "" : null;
      },
    },
  };
}

describe("detectSandboxImage", () => {
  it("picks android for a Flutter app with an Android project", async () => {
    for (const settings of [
      "android/settings.gradle",
      "android/settings.gradle.kts",
    ]) {
      const { client } = repoWith(["pubspec.yaml", settings]);
      expect(await detectSandboxImage(client, repo)).toBe("android");
    }
  });

  it("has no opinion on a Flutter package without an Android project", async () => {
    const { client } = repoWith(["pubspec.yaml"]);
    expect(await detectSandboxImage(client, repo)).toBeUndefined();
  });

  it("costs a non-Flutter repo one read", async () => {
    const { client, reads } = repoWith(["android/settings.gradle"]);
    expect(await detectSandboxImage(client, repo)).toBeUndefined();
    expect(reads).toEqual(["pubspec.yaml"]);
  });

  it("never fails the link on a provider error", async () => {
    const client = {
      readFile: async () => {
        throw new Error("rate limited");
      },
    };
    expect(await detectSandboxImage(client, repo)).toBeUndefined();
  });
});
