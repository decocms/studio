/**
 * The content protocol's method types: JSON-RPC 2.0 over one HTTP endpoint,
 * four methods (`describe`, `schema.get`, `blocks.list`, `blocks.apply`).
 */

export const PROTOCOL_NAME = "deco-content";

/** Minors only add; a client refuses an unknown major. */
export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

export const SCHEMA_FORMAT = "deco-meta@1";

/** The path the local server (`deco serve`) mounts the endpoint at. */
export const RPC_PATH = "/rpc";

/** The longest batch a request may carry. */
export const MAX_BATCH_CALLS = 10;

/** The URL prefix every uploaded asset is stored under in a field. */
export const ASSETS_URL_PREFIX = "/assets/";

export interface Limits {
  /** Names (set plus delete) in one `blocks.apply`. */
  maxOpsPerApply: number;
  /** Bytes of one stored entry. */
  maxBlockBytes: number;
  /** Bytes of one HTTP request body, uncompressed. */
  maxRequestBytes: number;
  /** Uncompressed bytes of the whole block list. */
  maxListBytes: number;
  /** Uncompressed bytes of the schema. */
  maxSchemaBytes: number;
  /** Uncompressed bytes of a whole batch response. */
  maxBatchResponseBytes: number;
}

const MiB = 1024 * 1024;

/** The protocol's default limits. A storage or a server can lower them. */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxOpsPerApply: 500,
  maxBlockBytes: 1 * MiB,
  maxRequestBytes: 8 * MiB,
  maxListBytes: 16 * MiB,
  maxSchemaBytes: 16 * MiB,
  maxBatchResponseBytes: 32 * MiB,
});

export type StorageKind = "working-tree" | "git";

export interface DescribeResult {
  protocol: typeof PROTOCOL_NAME;
  version: { major: 1; minor: number };
  server: { name: string; version: string };
  /** The site editor hides publish and draft UI for a working tree. */
  kind: StorageKind;
  readOnly: boolean;
  /** The app root: the folder that contains `.deco/`, relative to the repository root. */
  root: string;
  schemaFormat: typeof SCHEMA_FORMAT;
  /** Branches; `null` on the local server. */
  refs: null | { default: string; autoCreate: boolean };
  writes: {
    idempotency: null | { retentionMs: number };
    schemaPreconditions: boolean;
  };
  /** Local: 2000; git: 30000, plus on window focus. */
  pollIntervalMs: number;
  limits: Limits;
  /**
   * The app the site editor shows in its Preview tab (and where "open the real
   * page" points); the local server reports `deco serve --preview`. `null`: no preview.
   */
  preview: null | { url: string };
  /** Dir relative to the repository root; `null` when read-only or uploads go to hosted storage. */
  assets: null | {
    dir: string;
    urlPrefix: typeof ASSETS_URL_PREFIX;
    maxBytes: number;
  };
  /** The contents of `<root>/.deco/secrets.pub`; `null` without one. */
  secrets: null | { publicKey: string };
}

/** The schema file, in the site editor's `deco-meta@1` format. */
export interface DecoMeta {
  manifest?: { blocks?: Record<string, Record<string, unknown>> };
  schema?: {
    definitions?: Record<string, unknown>;
    root?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface ReadParams {
  ref?: string;
  ifNoneMatch?: string;
}

export type SchemaGetParams = ReadParams;

export type SchemaGetResult =
  | { notModified: true; version: string }
  | {
      notModified: false;
      version: string;
      resolvedRef: string | null;
      schema: DecoMeta;
    };

export type BlocksListParams = ReadParams;

/** A file `blocks.list` skipped or shadowed. */
export interface Diagnostic {
  /** The file name inside `.deco/blocks`. */
  file: string;
  kind: "invalid-json" | "not-an-object" | "too-large" | "shadowed";
  message: string;
  /** For `shadowed`: the entry the file is a spelling of. */
  name?: string;
  /** For `shadowed`: the file that won. */
  winner?: string;
}

export type BlocksListResult =
  | { notModified: true; revision: string; resolvedRef: string | null }
  | {
      notModified: false;
      revision: string;
      resolvedRef: string | null;
      /** Every saved block, by name. */
      blocks: Record<string, Record<string, unknown>>;
      /** One opaque version per entry. */
      versions: Record<string, string>;
      /** Files skipped or shadowed. */
      diagnostics: Diagnostic[];
    };

export interface BlocksApplyParams {
  ref?: string;
  /** Retry the same logical write; only when advertised. */
  requestKey?: string;
  /** Reject if the schema changed; only when advertised. */
  ifSchemaMatch?: string;
  /** Whole-entry replace (create or update). */
  set?: Record<string, Record<string, unknown>>;
  /** A missing name counts as deleted. */
  delete?: string[];
  /** A version the entry must have; `null` = must not exist. */
  ifMatch?: Record<string, string | null>;
}

export interface BlocksApplyResult {
  revision: string;
  versions: Record<string, string | null>;
}

/** The four methods, by wire name. */
export interface Methods {
  describe: {
    params: Record<string, never> | undefined;
    result: DescribeResult;
  };
  "schema.get": {
    params: SchemaGetParams | undefined;
    result: SchemaGetResult;
  };
  "blocks.list": {
    params: BlocksListParams | undefined;
    result: BlocksListResult;
  };
  "blocks.apply": { params: BlocksApplyParams; result: BlocksApplyResult };
}

export type MethodName = keyof Methods;

export const METHOD_NAMES: readonly MethodName[] = [
  "describe",
  "schema.get",
  "blocks.list",
  "blocks.apply",
];

/** A JSON-RPC request id. The protocol requires one on every request. */
export type RpcId = string | number;

export interface RpcRequest<M extends MethodName = MethodName> {
  jsonrpc: "2.0";
  id: RpcId;
  method: M;
  params?: Methods[M]["params"];
}

export type RpcResponse<R = unknown> =
  | { jsonrpc: "2.0"; id: RpcId | null; result: R }
  | {
      jsonrpc: "2.0";
      id: RpcId | null;
      error: { code: number; message: string; data?: unknown };
    };
