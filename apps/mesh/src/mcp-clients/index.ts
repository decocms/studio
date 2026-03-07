/**
 * MCP Clients Module
 *
 * Provides factories for creating MCP clients and servers from connections:
 * - clientFromConnection: Creates a client from a connection entity
 * - serverFromConnection: Creates a server from a connection entity with custom behaviors
 */

export { clientFromConnection } from "./client";
export { serverFromConnection } from "./server";
export * from "./decorators";
