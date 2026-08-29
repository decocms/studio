/**
 * Transport Composition
 *
 * Base wrapper transport class and composition helper for building
 * middleware pipelines at the transport layer.
 */

import type {
  JSONRPCMessage,
  JSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Transport middleware function type
 * Takes a transport and returns a wrapped transport
 */
export type TransportMiddleware = (transport: Transport) => Transport;

/**
 * Base wrapper transport that delegates to an inner transport
 * Override handleOutgoingMessage/handleIncomingMessage to intercept messages
 */
export abstract class WrapperTransport implements Transport {
  constructor(protected innerTransport: Transport) {}

  get sessionId(): string | undefined {
    return this.innerTransport.sessionId;
  }

  async start(): Promise<void> {
    // Set up message forwarding before starting
    this.innerTransport.onmessage = (message: JSONRPCMessage) => {
      this.handleIncomingMessage(message);
    };

    this.innerTransport.onerror = (error: Error) => {
      this.onerror?.(error);
    };

    this.innerTransport.onclose = () => {
      this.onclose?.();
    };

    return this.innerTransport.start();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    return this.handleOutgoingMessage(message);
  }

  async close(): Promise<void> {
    return this.innerTransport.close();
  }

  /**
   * Override in subclasses to intercept outgoing messages
   * Default: forward to inner transport
   */
  protected async handleOutgoingMessage(
    message: JSONRPCMessage,
  ): Promise<void> {
    return this.innerTransport.send(message);
  }

  /**
   * Override in subclasses to intercept incoming messages
   * Default: forward to onmessage callback
   */
  protected handleIncomingMessage(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  /**
   * Helper to check if message is a JSON-RPC request
   */
  protected isRequest(message: JSONRPCMessage): message is JSONRPCRequest {
    return "method" in message && message.method !== undefined;
  }

  /**
   * Helper to check if message is a JSON-RPC response
   */
  protected isResponse(message: JSONRPCMessage): boolean {
    return (
      "result" in message || ("error" in message && !("method" in message))
    );
  }

  // Transport callbacks
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
}

/**
 * Compose multiple transport middlewares
 * Applies from left to right (first middleware wraps innermost)
 *
 * @example
 * const transport = composeTransport(
 *   baseTransport,
 *   (t) => new AuthTransport(t, options),
 *   (t) => new MonitoringTransport(t, options)
 * );
 * // Request flow: MonitoringTransport -> AuthTransport -> baseTransport
 * // Response flow: baseTransport -> AuthTransport -> MonitoringTransport
 */
export function composeTransport(
  baseTransport: Transport,
  ...middlewares: TransportMiddleware[]
): Transport {
  return middlewares.reduce(
    (transport, middleware) => middleware(transport),
    baseTransport,
  );
}
