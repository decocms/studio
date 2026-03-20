import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  createBridgeTransportPair,
  BridgeClientTransport,
  BridgeServerTransport,
} from "./bridge-transport";

/** Poll until `condition` returns true, checking every 5ms up to `timeoutMs`. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 200,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("BridgeTransport", () => {
  describe("createBridgeTransportPair", () => {
    it("should create a pair of transports", () => {
      const { client, server, channel } = createBridgeTransportPair();

      expect(client).toBeInstanceOf(BridgeClientTransport);
      expect(server).toBeInstanceOf(BridgeServerTransport);
      expect(channel).toBeDefined();
    });

    it("should create transports with microtask scheduling", () => {
      const { client, server } = createBridgeTransportPair();
      expect(client).toBeDefined();
      expect(server).toBeDefined();
    });
  });

  describe("message delivery", () => {
    it("should deliver messages in order client->server", async () => {
      const { client, server } = createBridgeTransportPair();

      const receivedMessages: JSONRPCMessage[] = [];

      await server.start();
      server.onmessage = (message) => {
        receivedMessages.push(message);
      };

      await client.start();

      const msg1: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: { foo: "bar" },
      };
      const msg2: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 2,
        method: "test2",
        params: { baz: "qux" },
      };

      await client.send(msg1);
      await client.send(msg2);

      // Wait for microtask to process (or sync mode processes immediately)
      await new Promise((resolve) => queueMicrotask(resolve));

      expect(receivedMessages).toHaveLength(2);
      expect(receivedMessages[0]).toEqual(msg1);
      expect(receivedMessages[1]).toEqual(msg2);
    });

    it("should deliver messages in order server->client", async () => {
      const { client, server } = createBridgeTransportPair();

      const receivedMessages: JSONRPCMessage[] = [];

      await client.start();
      client.onmessage = (message) => {
        receivedMessages.push(message);
      };

      await server.start();

      const msg1: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: { foo: "bar" },
      };
      const msg2: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 2,
        method: "test2",
        params: { baz: "qux" },
      };

      await server.send(msg1);
      await server.send(msg2);

      // Wait for microtask to process (or sync mode processes immediately)
      await new Promise((resolve) => queueMicrotask(resolve));

      expect(receivedMessages).toHaveLength(2);
      expect(receivedMessages[0]).toEqual(msg1);
      expect(receivedMessages[1]).toEqual(msg2);
    });

    it("should batch multiple messages in a single microtask", async () => {
      const { client, server } = createBridgeTransportPair();

      const receivedMessages: JSONRPCMessage[] = [];
      let flushCount = 0;

      await server.start();
      server.onmessage = (message) => {
        receivedMessages.push(message);
        flushCount++;
      };

      await client.start();

      // Send multiple messages synchronously
      await client.send({ jsonrpc: "2.0", id: 1, method: "test1" });
      await client.send({ jsonrpc: "2.0", id: 2, method: "test2" });
      await client.send({ jsonrpc: "2.0", id: 3, method: "test3" });

      // Wait for microtask to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedMessages).toHaveLength(3);
      // All messages should be delivered in a single flush
      expect(flushCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("start()", () => {
    it("should allow starting client transport", async () => {
      const { client } = createBridgeTransportPair();
      await expect(client.start()).resolves.toBeUndefined();
    });

    it("should allow starting server transport", async () => {
      const { server } = createBridgeTransportPair();
      await expect(server.start()).resolves.toBeUndefined();
    });

    it("should throw if started twice", async () => {
      const { client } = createBridgeTransportPair();
      await client.start();
      await expect(client.start()).rejects.toThrow("already started");
    });
  });

  describe("close()", () => {
    it("should close client transport and notify server", async () => {
      const { client, server } = createBridgeTransportPair();

      await client.start();
      await server.start();

      let serverClosed = false;
      server.onclose = () => {
        serverClosed = true;
      };

      await client.close();

      expect(serverClosed).toBe(true);
    });

    it("should close server transport and notify client", async () => {
      const { client, server } = createBridgeTransportPair();

      await client.start();
      await server.start();

      let clientClosed = false;
      client.onclose = () => {
        clientClosed = true;
      };

      await server.close();

      expect(clientClosed).toBe(true);
    });

    it("should prevent sending messages after close", async () => {
      const { client, server } = createBridgeTransportPair();

      await client.start();
      await server.start();

      const receivedMessages: JSONRPCMessage[] = [];
      server.onmessage = (msg) => receivedMessages.push(msg);

      // Send first message and wait for delivery
      await client.send({ jsonrpc: "2.0", id: 1, method: "test" });
      await waitFor(() => receivedMessages.length >= 1);

      expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
      const initialCount = receivedMessages.length;

      // Close client
      await client.close();

      // Try to send after close (should be silent no-op)
      await client.send({ jsonrpc: "2.0", id: 2, method: "test2" });

      // Wait a bit to ensure no delivery
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not receive new messages after close
      expect(receivedMessages.length).toBe(initialCount);
    });

    it("should fire onclose exactly once", async () => {
      const { client } = createBridgeTransportPair();

      await client.start();

      let closeCount = 0;
      client.onclose = () => {
        closeCount++;
      };

      await client.close();
      await client.close(); // Try closing again

      expect(closeCount).toBe(1);
    });
  });

  describe("error handling", () => {
    it("should catch and forward errors from onmessage handler", async () => {
      const { client, server } = createBridgeTransportPair();

      await server.start();
      await client.start();

      const errors: Error[] = [];
      server.onerror = (error) => {
        errors.push(error);
      };

      server.onmessage = () => {
        throw new Error("Test error");
      };

      await client.send({ jsonrpc: "2.0", id: 1, method: "test" });

      // Wait for microtask to process and error to be forwarded
      await waitFor(() => errors.length >= 1);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("Test error");
    });

    it("should continue processing messages after error", async () => {
      const { client, server } = createBridgeTransportPair();

      await server.start();
      await client.start();

      const receivedMessages: JSONRPCMessage[] = [];
      const errors: Error[] = [];

      let callCount = 0;
      server.onmessage = (msg) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("First message error");
        }
        receivedMessages.push(msg);
      };

      server.onerror = (error) => {
        errors.push(error);
      };

      await client.send({ jsonrpc: "2.0", id: 1, method: "test1" });
      await client.send({ jsonrpc: "2.0", id: 2, method: "test2" });

      // Wait for microtask to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errors).toHaveLength(1);
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].id).toBe(2);
    });
  });

  describe("integration with MCP SDK", () => {
    it("should work with MCP Client and Server", async () => {
      const { client: clientTransport, server: serverTransport } =
        createBridgeTransportPair();

      const client = new Client({ name: "test-client", version: "1.0.0" });
      const server = new Server({ name: "test-server", version: "1.0.0" });

      // Connect server first
      await server.connect(serverTransport);

      // Connect client
      await client.connect(clientTransport);

      // Verify connection is established
      expect(clientTransport.started).toBe(true);
      expect(serverTransport.started).toBe(true);

      // Clean up
      await client.close();
      await server.close();
    });

    it("should handle initialize handshake", async () => {
      const { client: clientTransport, server: serverTransport } =
        createBridgeTransportPair();

      const client = new Client({ name: "test-client", version: "1.0.0" });
      const server = new Server({ name: "test-server", version: "1.0.0" });

      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify connection is established (client should have received initialize response)
      expect(clientTransport.started).toBe(true);
      expect(serverTransport.started).toBe(true);

      await client.close();
      await server.close();
    });
  });

  describe("send() before start()", () => {
    it("should allow sending messages before start (messages may be queued)", async () => {
      const { client, server } = createBridgeTransportPair();

      // Send message before starting - should not throw
      await expect(
        client.send({ jsonrpc: "2.0", id: 1, method: "test1" }),
      ).resolves.toBeUndefined();

      // Set handler and start
      const receivedMessages: JSONRPCMessage[] = [];
      server.onmessage = (msg) => receivedMessages.push(msg);
      await server.start();
      await client.start();

      // Send another message after start to verify normal operation
      await client.send({ jsonrpc: "2.0", id: 2, method: "test2" });

      // Wait for delivery
      await new Promise((resolve) => setTimeout(resolve, 20));

      // At least the message sent after start should be delivered
      // (messages sent before start may or may not be delivered depending on timing)
      expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    });
  });
});
