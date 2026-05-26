/**
 * File upload proxy
 *
 * `POST /api/:org/file-configs/:id/upload?filename=<encoded>` accepts the
 * file bytes as the raw request body (NOT multipart) and streams them
 * through `@aws-sdk/lib-storage` `Upload` to the configured bucket using
 * the server-side decrypted credentials.
 *
 * Why raw body and not multipart? Hono's `c.req.formData()` materializes
 * the entire multipart body before yielding the file, which defeats the
 * point of streaming for the 100 MB cap. Accepting the file directly as
 * the POST body keeps memory bounded.
 *
 * Why `Upload` (lib-storage) and not a single `PutObjectCommand`? Upload
 * automatically switches to multipart for large files, uploads parts in
 * parallel, and survives transient part failures — none of which a
 * single-shot PutObject offers when the SDK can't replay a stream.
 *
 * The presigned-PUT path (`FILE_PRESIGN_UPLOAD` MCP tool) remains
 * available for non-browser callers that can ignore CORS.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
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
    // Gate behind the same permission that grants access to the FILE_*
    // MCP tools (file-configs:manage in registry-metadata.ts). HTTP routes
    // don't auto-bind a tool name, so the resource has to be explicit.
    await ctx.access.check("FILE_OBJECTS_LIST");

    const configId = c.req.param("id");
    if (!configId) {
      throw new HTTPException(400, { message: "Missing config id" });
    }

    const filename = c.req.query("filename");
    if (!filename) {
      throw new HTTPException(400, {
        message: "Missing `filename` query parameter",
      });
    }

    const contentType =
      c.req.header("content-type") || "application/octet-stream";
    const contentLengthHeader = c.req.header("content-length");
    const contentLength = contentLengthHeader
      ? Number(contentLengthHeader)
      : NaN;
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      throw new HTTPException(411, {
        message: "Content-Length required and must be a positive number",
      });
    }

    try {
      assertAllowed(contentType, contentLength);
    } catch (err) {
      if (err instanceof UploadRejected) {
        throw new HTTPException(contentLength > MAX_UPLOAD_BYTES ? 413 : 400, {
          message: err.message,
        });
      }
      throw err;
    }

    const body = c.req.raw.body;
    if (!body) {
      throw new HTTPException(400, { message: "Empty request body" });
    }

    const fileCfg = await ctx.storage.orgFileConfigs.resolveById(
      configId,
      orgId,
    );

    const key = buildObjectKey({
      prefix: fileCfg.info.prefix,
      filename,
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

    try {
      const upload = new Upload({
        client,
        params: {
          Bucket: fileCfg.info.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: contentLength,
        },
        // 8 MB per part keeps part count reasonable for 100 MB uploads
        // (~13 parts) while staying well above the 5 MB S3 minimum.
        partSize: 8 * 1024 * 1024,
        queueSize: 4,
      });
      await upload.done();
    } catch (err) {
      throw new HTTPException(502, {
        message: `Upload to bucket failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    return c.json({
      key,
      publicUrl: buildPublicUrl(fileCfg.info, key),
      contentType,
      size: contentLength,
    });
  });

  return app;
};
