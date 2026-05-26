/**
 * File upload proxy
 *
 * `POST /api/:org/file-configs/:id/upload` accepts a multipart/form-data
 * body and streams the file to the configured S3 bucket using the
 * server-side decrypted credentials. This bypasses the browser→S3 CORS
 * requirement that presigned PUTs hit on non-AWS providers (GCS, R2,
 * MinIO). Trade-off: every upload streams through mesh — capped at 25MB
 * per the existing upload policy.
 *
 * The presigned-PUT path (`FILE_PRESIGN_UPLOAD` MCP tool) remains
 * available for non-browser callers that can ignore CORS.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MeshContext } from "@/core/mesh-context";
import { buildPublicUrl } from "@/file-storage/file-config-s3";
import {
  MAX_UPLOAD_BYTES,
  UploadRejected,
  assertAllowed,
  buildObjectKey,
} from "@/file-storage/upload-policy";

type Variables = { meshContext: MeshContext };

export const createFileUploadRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/file-configs/:id/upload", async (c) => {
    const ctx = c.get("meshContext");
    const userId = ctx.auth?.user?.id;
    if (!userId) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const orgId = ctx.organization?.id;
    if (!orgId) {
      throw new HTTPException(400, { message: "Organization required" });
    }
    await ctx.access.check();

    const configId = c.req.param("id");
    if (!configId) {
      throw new HTTPException(400, { message: "Missing config id" });
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_UPLOAD_BYTES * 1.1) {
      // Hard cap on the wire — leave 10% headroom for multipart overhead;
      // the per-file check below enforces the real limit.
      throw new HTTPException(413, { message: "Payload too large" });
    }

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch (err) {
      throw new HTTPException(400, {
        message: `Invalid multipart body: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new HTTPException(400, {
        message: "Missing `file` field in multipart body",
      });
    }

    const contentType = file.type || "application/octet-stream";
    try {
      assertAllowed(contentType, file.size);
    } catch (err) {
      if (err instanceof UploadRejected) {
        throw new HTTPException(400, { message: err.message });
      }
      throw err;
    }

    const fileCfg = await ctx.storage.orgFileConfigs.resolveById(
      configId,
      orgId,
    );

    const key = buildObjectKey({
      prefix: fileCfg.info.prefix,
      filename: file.name,
    });

    const client = new S3Client({
      region: fileCfg.info.region,
      endpoint: fileCfg.info.endpoint ?? undefined,
      forcePathStyle: fileCfg.info.forcePathStyle,
      credentials: {
        accessKeyId: fileCfg.credentials.accessKeyId,
        secretAccessKey: fileCfg.credentials.secretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });

    // For 25MB files arrayBuffer is fine; if we ever raise the cap we'd
    // want a streaming PutObject (or multipart upload) here.
    const buffer = new Uint8Array(await file.arrayBuffer());
    await client.send(
      new PutObjectCommand({
        Bucket: fileCfg.info.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );

    return c.json({
      key,
      publicUrl: buildPublicUrl(fileCfg.info, key),
      contentType,
      size: file.size,
    });
  });

  return app;
};
