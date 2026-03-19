/**
 * MCP Client Decorators
 *
 * Provides decorator functions that enhance MCP clients with additional functionality:
 * - withStreamingSupport: Adds streaming support for HTTP connections
 */

export {
  withStreamingSupport,
  type ClientWithOptionalStreamingSupport,
  type ClientWithStreamingSupport,
} from "./with-streaming-support";
