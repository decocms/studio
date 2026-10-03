/**
 * What every conformance case gets: a client, raw HTTP access, the endpoint's
 * `describe`, unique names and assertion helpers.
 */
import { canonicalJson } from "../canonical";
import {
  type ContentClient,
  createContentClient,
  readResponseJson,
} from "../client";
import { ContentProtocolError } from "../errors";
import type { DescribeResult } from "../types";

export interface ConformanceOptions {
  /** The endpoint URL, such as `http://127.0.0.1:4545/rpc`. */
  endpoint: string | URL;
  /** The bearer token the endpoint expects, if any. */
  token?: string;
  /** Extra headers on every request (an auth cookie, a tenant header). */
  headers?: Record<string, string>;
  /** A fetch implementation (defaults to the global one); use it to call a handler in process. */
  fetch?: (request: Request) => Promise<Response>;
  /**
   * A block type in the endpoint's schema with a `Secret` field, so the
   * secret guard can be checked. Leave out to skip those cases.
   */
  secretField?: { blockType: string; field: string };
  /** The `.deco/secrets.pub` content the endpoint should report, if the harness wrote one. */
  secretsPublicKey?: string;
  /** Whether the endpoint has a schema (default true). `false` checks NotFound instead. */
  hasSchema?: boolean;
  /**
   * The endpoint serves a schema larger than its `limits.maxSchemaBytes`, so
   * reading it and writes that depend on it must be LimitExceeded. Run such
   * an endpoint with only the `limits/schema-bytes` case (pass a filter to
   * `runConformance` or `defineConformanceSuite`): every other case expects
   * a schema it can read.
   */
  schemaOverLimit?: boolean;
  /**
   * The URL prefix uploads are served under (`PUT <assetsEndpoint><name>`),
   * such as `http://127.0.0.1:4545/assets/`. Leave out to skip the upload cases.
   */
  assetsEndpoint?: string | URL;
  /**
   * Restarts the server, keeping its durable state, to check that request-key
   * receipts survive a restart. Leave out to skip that case.
   */
  restart?: () => Promise<void>;
  /** Credentials of another tenant on the same storage, to check receipt isolation. */
  otherTenant?: { token?: string; headers?: Record<string, string> };
  /** Prefix of every name the suite creates (default `conformance-<random>`). */
  namePrefix?: string;
}

/** Thrown by `ctx.skip()`: the case doesn't apply to this endpoint. */
export class SkipCase extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipCase";
  }
}

export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceFailure";
  }
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export class ConformanceContext {
  readonly client: ContentClient;
  private counter = 0;
  private readonly created = new Set<string>();
  private describeResult: DescribeResult | undefined;

  constructor(
    readonly options: ConformanceOptions,
    readonly prefix: string,
  ) {
    this.client = createContentClient(options);
  }

  /** A client with other credentials (for tenant isolation). */
  clientFor(credentials: {
    token?: string;
    headers?: Record<string, string>;
  }): ContentClient {
    return createContentClient({ ...this.options, ...credentials });
  }

  async describe(): Promise<DescribeResult> {
    this.describeResult ??= await this.client.describe();
    return this.describeResult;
  }

  /** A fresh name the suite owns; it's deleted when the case ends. */
  name(label = "entry"): string {
    const name = `${this.prefix}-${label}-${++this.counter}`;
    this.created.add(name);
    return name;
  }

  /** Marks a name the case created by other means for cleanup. */
  track(name: string): void {
    this.created.add(name);
  }

  /** Deletes every name the case created. */
  async cleanup(): Promise<void> {
    if (this.created.size === 0) return;
    const names = [...this.created];
    this.created.clear();
    const description = await this.describe();
    if (description.readOnly) return;
    for (let i = 0; i < names.length; i += description.limits.maxOpsPerApply) {
      await this.client
        .blocksApply({
          delete: names.slice(i, i + description.limits.maxOpsPerApply),
        })
        .catch(() => {});
    }
  }

  skip(reason: string): never {
    throw new SkipCase(reason);
  }

  /** Posts a raw body to the endpoint and decodes the JSON answer. */
  async raw(
    body: string | Uint8Array,
    init: { method?: string; headers?: Record<string, string> } = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.options.headers,
      ...init.headers,
    };
    if (this.options.token !== undefined && !("authorization" in headers)) {
      headers.authorization = `Bearer ${this.options.token}`;
    }
    for (const [key, value] of Object.entries(headers))
      if (value === "") delete headers[key];
    const method = init.method ?? "POST";
    const doFetch =
      this.options.fetch ?? ((request: Request) => fetch(request));
    const response = await doFetch(
      new Request(this.options.endpoint, {
        method,
        headers,
        body:
          method === "GET" || method === "HEAD"
            ? undefined
            : (body as BodyInit),
      }),
    );
    let parsed: unknown = null;
    try {
      parsed = await readResponseJson(response);
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }

  /** Uploads `body` as `PUT <assetsEndpoint><name>`, with the endpoint's credentials. */
  async upload(
    name: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<RawResponse> {
    const base = this.options.assetsEndpoint;
    if (base === undefined) return this.skip("no assetsEndpoint");
    const headers: Record<string, string> = {
      ...this.options.headers,
      "content-type": contentType,
    };
    if (this.options.token !== undefined)
      headers.authorization = `Bearer ${this.options.token}`;
    const doFetch =
      this.options.fetch ?? ((request: Request) => fetch(request));
    const url = new URL(
      encodeURIComponent(name),
      new URL(String(base)).href.replace(/\/?$/, "/"),
    );
    const response = await doFetch(
      new Request(url, { method: "PUT", headers, body: body as BodyInit }),
    );
    let parsed: unknown = null;
    try {
      parsed = await readResponseJson(response);
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }

  /** Posts one JSON-RPC payload (an object or a batch) as JSON. */
  rpc(
    payload: unknown,
    headers?: Record<string, string>,
  ): Promise<RawResponse> {
    return this.raw(JSON.stringify(payload), { headers });
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

export function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const a = canonicalJson(actual ?? null);
  const e = canonicalJson(expected ?? null);
  if (a !== e)
    throw new ConformanceFailure(
      `${message}\n  expected: ${e}\n  actual:   ${a}`,
    );
}

/** Awaits `promise` and checks it fails with protocol error `code`. */
export async function expectError(
  promise: Promise<unknown>,
  code: number,
  message: string,
): Promise<ContentProtocolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ContentProtocolError) {
      assert(
        error.code === code,
        `${message}: expected error ${code}, got ${error.code} (${error.message})`,
      );
      return error;
    }
    throw error;
  }
  throw new ConformanceFailure(
    `${message}: expected error ${code}, but the call succeeded`,
  );
}

/** The JSON-RPC error code of a raw response body, if it carries one. */
export function rawErrorCode(body: unknown): number | undefined {
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === "number" ? error.code : undefined;
}
