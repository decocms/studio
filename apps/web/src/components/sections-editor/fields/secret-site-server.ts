import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test stand-in for a deco site's `secrets/encrypt.ts` action: a real HTTP
 * server that AES-CBC encrypts with its own key (like `DECO_CRYPTO_KEY`), so
 * tests assert the hex round-trips instead of trusting an invented response.
 */

type Mode = "ok" | "fail" | "echo" | "legacy-only";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string) =>
  new Uint8Array(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));

export async function startSecretSite(mode: Mode = "ok") {
  const key = await crypto.subtle.generateKey(
    { name: "AES-CBC", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const requests: { method: string; url: string; body: string }[] = [];
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  const respond = (res: ServerResponse, status: number, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...cors,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return respond(res, 204);
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = `http://${req.headers.host}${req.url}`;
    requests.push({ method: req.method ?? "", url, body });
    const path = new URL(url).pathname;
    const legacy = path === "/live/invoke/$live/actions/secrets/encrypt.ts";
    const current = path === "/live/invoke/website/actions/secrets/encrypt.ts";
    if (mode === "fail") return respond(res, 500, { error: "boom" });
    if (!(current && mode !== "legacy-only") && !legacy) {
      return respond(res, 404, { error: "not found" });
    }
    const { value } = JSON.parse(body) as { value: string };
    if (mode === "echo") return respond(res, 200, { value });
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-CBC", iv },
        key,
        new TextEncoder().encode(value),
      ),
    );
    respond(res, 200, { value: toHex(iv) + toHex(encrypted) });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    async decrypt(hex: string) {
      const bytes = fromHex(hex);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-CBC", iv: bytes.slice(0, 16) },
        key,
        bytes.slice(16),
      );
      return new TextDecoder().decode(plain);
    },
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
