/**
 * S3Store — SandboxStore backed by S3. Uses `@aws-sdk/client-s3`, which
 * picks up IRSA credentials via the default provider chain when running
 * in EKS (no explicit access keys required). Local/dev wiring still
 * works with `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` set in env.
 *
 * The SandboxStore key (e.g. `<orgId>/<vmcpId>/<branch>.tar`) gets the
 * configured `prefix` prepended so multiple environments / use-cases can
 * share one bucket.
 */

import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { SandboxStore, SnapshotHead } from "./types";

export interface S3StoreOptions {
  bucket: string;
  region?: string;
  /** Prefix prepended to every key (e.g. `sandbox-snapshots`). */
  prefix?: string;
  /** Override the S3 endpoint (used for localstack / R2 / MinIO testing). */
  endpoint?: string;
  /** Path-style addressing — needed by some S3-compatible backends. */
  forcePathStyle?: boolean;
}

export class S3Store implements SandboxStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3StoreOptions) {
    if (!opts.bucket) throw new Error("S3Store: bucket is required");
    this.bucket = opts.bucket;
    this.prefix = opts.prefix?.replace(/\/+$/, "") ?? "";
    this.client = new S3Client({
      region: opts.region ?? "us-east-1",
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
    });
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<void> {
    const Body =
      body instanceof Uint8Array
        ? body
        : Readable.fromWeb(
            body as unknown as NodeWebReadableStream<Uint8Array>,
          );
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: Body as Uint8Array | Readable,
      }),
    );
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      if (!res.Body) return null;
      // SDK v3 bodies implement `transformToWebStream()` in Node runtimes.
      return res.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<SnapshotHead | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return { size: res.ContentLength ?? 0, etag: res.ETag ?? "" };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
    );
  }

  /** Visible for tests — exposes the full S3 key for a given store key. */
  fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string; Code?: string } | null)?.name;
  const code = (err as { name?: string; Code?: string } | null)?.Code;
  // The SDK surfaces both NotFound (HEAD) and NoSuchKey (GET) for absent objects.
  return name === "NotFound" || name === "NoSuchKey" || code === "NoSuchKey";
}
