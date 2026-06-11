import { nanoid } from "nanoid";

/** Message ID generator. Use as a closure where a `() => string` is
 *  expected (e.g. toUIMessageStreamResponse). Portable harness leaf — does
 *  not reach the cluster `@/shared/utils/generate-id`. */
export const generateMessageId = () => `msg_${nanoid()}`;

export const DEFAULT_MAX_TOKENS = 32768;

/** Per-MCP-tool-call timeout. Portable mirror of `@/core/constants`'
 *  `MCP_TOOL_CALL_TIMEOUT_MS` (5 minutes). Lives here so the portable
 *  tool-assembly leaves don't reach the cluster constants module. */
export const MCP_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
