/**
 * Integration: S3Service against a real S3-compatible store (MinIO in CI).
 *
 * Guards the read-path contract that broke image generation (#3595):
 * getBytesOrPresign caps inline content at the caller's threshold, while
 * getBytes returns the full object regardless of size. DevObjectStorage (the
 * local backend) never capped, so only a real S3 backend exercises this.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { S3Service } from "./s3-service";

const ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID ?? "minioadmin";
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin";
const BUCKET = "s3-service-integration";
const ORG = "org_test";
const MIB = 1024 * 1024;

const config = {
  endpoint: ENDPOINT,
  bucket: BUCKET,
  region: "us-east-1",
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET_KEY,
  forcePathStyle: true,
};

const s3 = new S3Service(config);

function patternedBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  return bytes;
}

beforeAll(async () => {
  const client = new S3Client({
    endpoint: ENDPOINT,
    region: config.region,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    forcePathStyle: true,
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch {
    // Bucket may already exist from a previous run.
  }
});

describe("S3Service read paths", () => {
  test("getBytesOrPresign inlines content under the threshold", async () => {
    const key = "small.txt";
    await s3.put(ORG, key, "hello world");

    const result = await s3.getBytesOrPresign(ORG, key, {
      presignWhenLargerThan: MIB,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unreachable");
    expect(result.encoding).toBe("utf-8");
    expect(result.content).toBe("hello world");
  });

  test("getBytesOrPresign returns a presigned URL above the threshold", async () => {
    const key = "large.png";
    const bytes = patternedBytes(2 * MIB);
    await s3.put(ORG, key, bytes);

    const result = await s3.getBytesOrPresign(ORG, key, {
      presignWhenLargerThan: MIB,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("unreachable");
    expect(result.error).toBe("FILE_TOO_LARGE");
    expect(result.size).toBe(2 * MIB);
    expect(result.presignedUrl).toContain("http");
  });

  test("getBytes returns the full object regardless of size", async () => {
    const key = "large.png";
    const bytes = patternedBytes(2 * MIB);
    await s3.put(ORG, key, bytes);

    const raw = await s3.getBytes(ORG, key);

    expect(raw.byteLength).toBe(2 * MIB);
    expect(raw[0]).toBe(0);
    expect(raw[257]).toBe(1);
    expect(raw[2 * MIB - 1]).toBe((2 * MIB - 1) % 256);
  });

  test("a threshold above the object size inlines it instead of presigning", async () => {
    const key = "large.png";
    await s3.put(ORG, key, patternedBytes(2 * MIB));

    const result = await s3.getBytesOrPresign(ORG, key, {
      presignWhenLargerThan: 4 * MIB,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unreachable");
    expect(result.encoding).toBe("base64");
    expect(Buffer.from(result.content, "base64").byteLength).toBe(2 * MIB);
  });
});
