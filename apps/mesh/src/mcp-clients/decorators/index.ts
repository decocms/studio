/**
 * MCP Client Decorators
 *
 * Provides decorator functions that enhance MCP clients with additional functionality:
 * - withMcpCaching: Adds tool/resource/prompt list caching
 * - withStreamingSupport: Adds streaming support for HTTP connections
 */

export { withMcpCaching } from "./with-mcp-caching";
export {
  withStreamingSupport,
  type ClientWithOptionalStreamingSupport,
  type ClientWithStreamingSupport,
} from "./with-streaming-support";
