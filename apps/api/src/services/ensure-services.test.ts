import { describe, expect, it } from "bun:test";
import {
  buildManagedLinkSpawnCommand,
  minioArtifactName,
  minioDownloadUrl,
} from "./ensure-services";

describe("minioArtifactName", () => {
  it("returns the bare executable on unix platforms", () => {
    expect(minioArtifactName("darwin", "arm64")).toBe("minio");
    expect(minioArtifactName("linux", "x64")).toBe("minio");
  });

  it("appends .exe on windows", () => {
    expect(minioArtifactName("win32", "x64")).toBe("minio.exe");
  });
});

describe("minioDownloadUrl", () => {
  it("builds the darwin-arm64 release path", () => {
    expect(minioDownloadUrl("darwin", "arm64")).toBe(
      "https://dl.min.io/server/minio/release/darwin-arm64/minio",
    );
  });

  it("maps x64 to amd64 for linux", () => {
    expect(minioDownloadUrl("linux", "x64")).toBe(
      "https://dl.min.io/server/minio/release/linux-amd64/minio",
    );
  });

  it("builds the windows release path with the .exe artifact", () => {
    expect(minioDownloadUrl("win32", "x64")).toBe(
      "https://dl.min.io/server/minio/release/windows-amd64/minio.exe",
    );
  });

  it("throws on an unsupported platform", () => {
    expect(() => minioDownloadUrl("sunos", "sparc")).toThrow(
      /Unsupported platform for MinIO/,
    );
  });
});

describe("buildManagedLinkSpawnCommand", () => {
  it("adds Bun hot reload and forwards --hot to the link command", () => {
    expect(
      buildManagedLinkSpawnCommand({
        clusterUrl: "http://lagos.localhost",
        port: 5174,
        hotReload: true,
      }),
    ).toEqual([
      "bun",
      "--hot",
      "run",
      "--cwd=apps/api",
      "src/cli.ts",
      "link",
      "http://lagos.localhost",
      "--port",
      "5174",
      "--no-tui",
      "--hot",
    ]);
  });

  it("keeps the existing link command shape when hot reload is disabled", () => {
    expect(
      buildManagedLinkSpawnCommand({
        clusterUrl: "http://lagos.localhost",
        port: 5174,
        hotReload: false,
      }),
    ).toEqual([
      "bun",
      "run",
      "--cwd=apps/api",
      "src/cli.ts",
      "link",
      "http://lagos.localhost",
      "--port",
      "5174",
      "--no-tui",
    ]);
  });
});
