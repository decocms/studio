/**
 * In-process, per-tenant, prefix-scoped TEMPORARY S3 credentials for the shared
 * managed assets bucket, minted via STS AssumeRole. Ported from the deco admin
 * platform (`clients/awsTenantCredentials.ts`) so studio no longer depends on a
 * live admin endpoint to vend credentials for migrated sites.
 *
 * Each call assumes a single shared role (`awsS3TenantRoleArn`) with a
 * per-request inline session policy narrowing access to the `<slug>/` key
 * prefix — the effective permissions are the INTERSECTION of the role's policy
 * and this document. Nothing is persisted in IAM. The credentials EXPIRE; the
 * AWS SDK's credential provider re-invokes the minter near expiry (the S3
 * client is cached per file config so this happens ~once/session, not per op).
 *
 * Provisioner identity: the cluster's ambient role by default (no stored key);
 * an explicit key pair (`awsS3TenantProvisioner*`) overrides it when configured.
 *
 * SECURITY: the slug is interpolated into the IAM session-policy resource ARN
 * and the S3 key prefix. `SLUG_RE` is the load-bearing guard preventing a `*`
 * or `/` from broadening the grant — keep it even though every caller passes a
 * slug sourced from `org_sites`. Never surface raw STS errors (AccessDenied
 * embeds the role ARN + account id).
 */

import {
  AssumeRoleCommand,
  type AssumeRoleCommandOutput,
  STSClient,
} from "@aws-sdk/client-sts";
import { retry, RetryError } from "@decocms/shared/std";
import { getSettings } from "@/settings";
import { SITE_SLUG_RE } from "@decocms/shared/site-slug";

const SLUG_RE = SITE_SLUG_RE;

export class TenantCredentialsError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TenantCredentialsError";
  }
}

export interface TenantS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

/** Storage descriptor (bucket/region/endpoint/CDN/prefix) for a managed slug. */
export interface TenantStorageDescriptor {
  bucket: string;
  region: string;
  endpoint: string | null;
  prefix: string;
  forcePathStyle: boolean;
  publicUrlBase: string;
}

let client: STSClient | null = null;

function getClient(): STSClient {
  if (client) return client;
  const settings = getSettings();
  const accessKeyId = settings.awsS3TenantProvisionerAccessKeyId;
  const secretAccessKey = settings.awsS3TenantProvisionerSecretAccessKey;
  client = new STSClient({
    region: settings.s3TenantRegion,
    // Explicit provisioner key pair when configured; otherwise the AWS default
    // provider chain resolves the cluster's ambient pod/instance role.
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });
  return client;
}

function roleArn(): string {
  const arn = getSettings().awsS3TenantRoleArn;
  if (!arn) {
    throw new TenantCredentialsError(
      500,
      "managed file configs require AWS_S3_TENANT_ROLE_ARN to be configured",
    );
  }
  return arn;
}

/** Build the storage descriptor for a managed site slug from settings. */
export function tenantStorageDescriptor(slug: string): TenantStorageDescriptor {
  if (!SLUG_RE.test(slug)) {
    throw new TenantCredentialsError(400, "invalid site slug");
  }
  const s = getSettings();
  return {
    bucket: s.s3TenantBucket,
    region: s.s3TenantRegion,
    endpoint: s.s3TenantEndpoint ?? null,
    prefix: `${slug}/`,
    forcePathStyle: false,
    publicUrlBase: s.s3TenantPublicUrlBase,
  };
}

/**
 * Inline session policy passed to AssumeRole. Narrows the role's broad bucket
 * access down to a single tenant prefix.
 */
function sessionPolicy(bucket: string, slug: string): string {
  const bucketArn = `arn:aws:s3:::${bucket}`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TenantObjectAccess",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        Resource: `${bucketArn}/${slug}/*`,
      },
      {
        Sid: "TenantPrefixList",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: bucketArn,
        Condition: { StringLike: { "s3:prefix": [`${slug}/*`] } },
      },
    ],
  });
}

export async function provisionTenantS3Credentials(
  slug: string,
): Promise<TenantS3Credentials> {
  if (!SLUG_RE.test(slug)) {
    throw new TenantCredentialsError(
      400,
      "site must be 1-60 chars of lowercase letters, digits, or hyphens, starting with a letter or digit",
    );
  }

  const settings = getSettings();
  // Resolve config (may throw a 500) BEFORE entering retry so a misconfiguration
  // fails fast rather than being retried and masked as a network error.
  const arn = roleArn();
  const policy = sessionPolicy(settings.s3TenantBucket, slug);

  let res: AssumeRoleCommandOutput;
  try {
    res = await retry(
      () =>
        getClient().send(
          new AssumeRoleCommand({
            RoleArn: arn,
            RoleSessionName: `s3-${slug}`,
            Policy: policy,
            // No DurationSeconds — use the AWS default session length (1h), so
            // the tenant role needs no elevated MaxSessionDuration. The SDK
            // refreshes the cached client's creds near expiry automatically.
          }),
        ),
      {
        maxAttempts: 3,
        // Don't burn retries on non-transient STS errors (e.g. AccessDenied);
        // retry only network errors or 5xx/throttling.
        isRetriable: (err) => {
          const status = (err as { $metadata?: { httpStatusCode?: number } })
            ?.$metadata?.httpStatusCode;
          const name = (err as { name?: string })?.name ?? "";
          return (
            status === undefined ||
            status >= 500 ||
            /throttl|timeout/i.test(name)
          );
        },
      },
    );
  } catch (e) {
    if (e instanceof TenantCredentialsError) throw e;
    // Unwrap RetryError so the real STS error (AccessDenied, missing
    // credentials, …) is logged instead of "maxAttempts exceeded". Logged
    // server-side only — never returned to the client (it embeds the role ARN
    // + account id).
    const cause = e instanceof RetryError ? (e.cause ?? e) : e;
    const detail =
      cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : String(cause);
    console.error(`[tenant-credentials] AssumeRole failed: ${detail}`);
    throw new TenantCredentialsError(500, "failed to mint tenant credentials");
  }

  const creds = res.Credentials;
  if (
    !creds?.AccessKeyId ||
    !creds?.SecretAccessKey ||
    !creds?.SessionToken ||
    !creds?.Expiration
  ) {
    throw new TenantCredentialsError(
      500,
      "assume role returned incomplete credentials",
    );
  }

  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
    expiration: creds.Expiration,
  };
}
