import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  buildS3Key,
  buildS3Prefix,
  detectContentType,
  isTextContentType,
  stripOrgPrefix,
} from "./key-utils";

/** 1 MB inline read limit */
const MAX_INLINE_SIZE = 1_048_576;

export interface S3ServiceConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface GetObjectResult {
  content: string;
  contentType: string;
  /** "utf-8" for text content, "base64" for binary */
  encoding: "utf-8" | "base64";
  size: number;
  lastModified?: Date;
  etag?: string;
}

export interface GetObjectTooLargeResult {
  error: "FILE_TOO_LARGE";
  size: number;
  maxInlineSize: number;
  presignedUrl: string;
  contentType: string;
}

export interface PutObjectResult {
  etag?: string;
  key: string;
}

export interface ListObjectEntry {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}

export interface ListObjectsResult {
  objects: ListObjectEntry[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface HeadObjectResult {
  contentType: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}

export class S3Service {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3ServiceConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });
  }

  async get(
    orgId: string,
    key: string,
  ): Promise<GetObjectResult | GetObjectTooLargeResult> {
    const s3Key = buildS3Key(orgId, key);

    // Head first to check size
    const headResult = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key }),
    );

    const size = headResult.ContentLength ?? 0;
    const contentType = headResult.ContentType ?? detectContentType(key);

    if (size > MAX_INLINE_SIZE) {
      const presignedUrl = await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
        { expiresIn: 3600 },
      );

      return {
        error: "FILE_TOO_LARGE",
        size,
        maxInlineSize: MAX_INLINE_SIZE,
        presignedUrl,
        contentType,
      };
    }

    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
    );

    const bodyBytes = await response.Body!.transformToByteArray();
    const isText = isTextContentType(contentType);

    return {
      content: isText
        ? new TextDecoder().decode(bodyBytes)
        : Buffer.from(bodyBytes).toString("base64"),
      contentType,
      encoding: isText ? "utf-8" : "base64",
      size,
      lastModified: headResult.LastModified,
      etag: headResult.ETag,
    };
  }

  async put(
    orgId: string,
    key: string,
    body: string | Uint8Array,
    options?: { contentType?: string },
  ): Promise<PutObjectResult> {
    const s3Key = buildS3Key(orgId, key);
    const contentType = options?.contentType ?? detectContentType(key);

    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: typeof body === "string" ? Buffer.from(body, "utf-8") : body,
        ContentType: contentType,
      }),
    );

    return {
      etag: response.ETag,
      key,
    };
  }

  async list(
    orgId: string,
    options?: {
      prefix?: string;
      maxKeys?: number;
      continuationToken?: string;
    },
  ): Promise<ListObjectsResult> {
    const s3Prefix = buildS3Prefix(orgId, options?.prefix);

    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: s3Prefix,
        MaxKeys: options?.maxKeys ?? 1000,
        ContinuationToken: options?.continuationToken,
      }),
    );

    return {
      objects: (response.Contents ?? []).map((obj) => ({
        key: stripOrgPrefix(orgId, obj.Key ?? ""),
        size: obj.Size ?? 0,
        lastModified: obj.LastModified,
        etag: obj.ETag,
      })),
      isTruncated: response.IsTruncated ?? false,
      nextContinuationToken: response.NextContinuationToken,
    };
  }

  async delete(orgId: string, key: string): Promise<void> {
    const s3Key = buildS3Key(orgId, key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: s3Key }),
    );
  }

  async head(orgId: string, key: string): Promise<HeadObjectResult> {
    const s3Key = buildS3Key(orgId, key);
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key }),
    );

    return {
      contentType: response.ContentType ?? detectContentType(key),
      size: response.ContentLength ?? 0,
      lastModified: response.LastModified,
      etag: response.ETag,
    };
  }
}
