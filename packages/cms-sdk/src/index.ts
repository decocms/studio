/**
 * @deco/cms-sdk
 *
 * SDK for deco Content Management System operations.
 * Provides daemon client, block utilities, schema fetching, and preview URL generation.
 */

// Daemon - WebSocket client for real-time file operations
export {
  DaemonClient,
  type DaemonConfig,
  type DaemonEvent,
  type DaemonEventType,
} from "./daemon/index.ts";

// Blocks - Block CRUD and path utilities
export {
  DECOFILE,
  inferMetadata,
  type Block,
  type BlockMetadata,
  type BlockType,
} from "./blocks/index.ts";

// Schema - JSON Schema fetching and resolution
export {
  fetchMeta,
  getBlockSchema,
  resolveRefs,
  type MetaInfo,
  type JSONSchema,
} from "./schema/index.ts";

// Preview - Preview URL generation
export {
  buildPreviewUrl,
  encodeProps,
  decodeProps,
  type PreviewOptions,
} from "./preview/index.ts";

