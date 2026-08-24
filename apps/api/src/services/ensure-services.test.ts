import { describe, expect, it } from "bun:test";
import {
  minioArtifactName,
  minioDownloadUrl,
  natsArtifactName,
  natsBinaryTempPath,
  readNatsBinaryFromTarGzip,
  shouldInstallExtractedNatsBinary,
} from "./ensure-services";

async function makeNatsTarGzip(
  artifact: string,
  contents: string,
): Promise<Uint8Array> {
  const archiveRoot = artifact.slice(0, -".tar.gz".length);
  return new Bun.Archive(
    {
      [`${archiveRoot}/LICENSE`]: "license",
      [`${archiveRoot}/nats-server`]: contents,
    },
    { compress: "gzip" },
  ).bytes();
}

describe("natsArtifactName", () => {
  it("uses tar.gz for unix artifacts", () => {
    expect(natsArtifactName("darwin", "arm64")).toBe(
      "nats-server-v2.14.2-darwin-arm64.tar.gz",
    );
    expect(natsArtifactName("linux", "x64")).toBe(
      "nats-server-v2.14.2-linux-amd64.tar.gz",
    );
  });

  it("keeps the Windows ZIP artifact", () => {
    expect(natsArtifactName("win32", "x64")).toBe(
      "nats-server-v2.14.2-windows-amd64.zip",
    );
  });

  it("throws on an unsupported platform", () => {
    expect(() => natsArtifactName("sunos", "sparc")).toThrow(
      /Unsupported platform/,
    );
  });
});

describe("readNatsBinaryFromTarGzip", () => {
  it("reads the executable from a gzipped NATS release archive", async () => {
    const artifact = "nats-server-v2.14.2-linux-amd64.tar.gz";
    const archive = await makeNatsTarGzip(artifact, "nats executable");

    const binary = await readNatsBinaryFromTarGzip(archive, artifact);

    expect(binary.name).toBe("nats-server-v2.14.2-linux-amd64/nats-server");
    expect(await binary.text()).toBe("nats executable");
  });

  it("supports archive roots longer than the legacy tar name field", async () => {
    const artifact = `nats-server-v2.14.2-${"long-".repeat(30)}linux-amd64.tar.gz`;
    const archive = await makeNatsTarGzip(artifact, "long path executable");

    const binary = await readNatsBinaryFromTarGzip(archive, artifact);

    expect(binary.name.length).toBeGreaterThan(100);
    expect(await binary.text()).toBe("long path executable");
  });

  it("propagates corrupt archive errors", async () => {
    await expect(
      readNatsBinaryFromTarGzip(
        new TextEncoder().encode("not a tar archive"),
        "nats-server-v2.14.2-linux-amd64.tar.gz",
      ),
    ).rejects.toThrow(/archive format/);
  });

  it("propagates truncated gzip errors", async () => {
    const artifact = "nats-server-v2.14.2-linux-amd64.tar.gz";
    const archive = await makeNatsTarGzip(artifact, "nats executable");

    await expect(
      readNatsBinaryFromTarGzip(archive.subarray(0, 32), artifact),
    ).rejects.toThrow(/truncated gzip input/);
  });

  it("rejects an archive without the expected executable", async () => {
    const artifact = "nats-server-v2.14.2-linux-amd64.tar.gz";
    const archive = await new Bun.Archive(
      { "unexpected/nats-server": "wrong binary" },
      { compress: "gzip" },
    ).bytes();

    await expect(readNatsBinaryFromTarGzip(archive, artifact)).rejects.toThrow(
      /NATS binary not found/,
    );
  });

  it("rejects the Windows archive format before parsing", async () => {
    await expect(
      readNatsBinaryFromTarGzip(
        new Uint8Array(),
        "nats-server-v2.14.2-windows-amd64.zip",
      ),
    ).rejects.toThrow(/Expected a \.tar\.gz NATS artifact/);
  });
});

describe("natsBinaryTempPath", () => {
  it("creates an adjacent path from explicit process and nonce inputs", () => {
    expect(natsBinaryTempPath("/srv/bin/nats-server", 42, "nonce-a")).toBe(
      "/srv/bin/nats-server.download-42-nonce-a",
    );
  });

  it("does not share a path between invocations in one process", () => {
    const first = natsBinaryTempPath("/srv/bin/nats-server", 42, "nonce-a");
    const second = natsBinaryTempPath("/srv/bin/nats-server", 42, "nonce-b");

    expect(first).not.toBe(second);
  });
});

describe("shouldInstallExtractedNatsBinary", () => {
  it("never replaces an already-installed Windows binary", () => {
    expect(shouldInstallExtractedNatsBinary(true, true)).toBe(false);
    expect(shouldInstallExtractedNatsBinary(true, false)).toBe(false);
  });

  it("moves only an available extracted binary into an empty destination", () => {
    expect(shouldInstallExtractedNatsBinary(false, true)).toBe(true);
    expect(shouldInstallExtractedNatsBinary(false, false)).toBe(false);
  });
});

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
