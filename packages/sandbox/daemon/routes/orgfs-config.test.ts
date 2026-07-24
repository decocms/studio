import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { makeOrgFsConfigHandler } from "./orgfs-config";

const CONFIG = JSON.stringify({
  baseUrl: "http://studio",
  orgSlug: "acme",
  token: "t",
  mounts: [{ volume: "skills", path: "skills" }],
});

const post = (body: string) =>
  new Request("http://daemon/_sandbox/orgfs-config", {
    method: "POST",
    body,
  });

describe("makeOrgFsConfigHandler", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orgfs-route-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a valid config to the relay path (creating parents)", async () => {
    const path = join(dir, "ctl", "config.json");
    const h = makeOrgFsConfigHandler({ configPath: path });
    const res = await h(post(CONFIG));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: true });
    expect(readFileSync(path, "utf8")).toBe(CONFIG);
  });

  it("rejects malformed and invalid-shape bodies with 400", async () => {
    const path = join(dir, "config.json");
    const h = makeOrgFsConfigHandler({ configPath: path });
    expect((await h(post("{nope"))).status).toBe(400);
    expect((await h(post(JSON.stringify({ baseUrl: "x" })))).status).toBe(400);
  });

  it("answers written:false when no relay path is configured (desktop)", async () => {
    const h = makeOrgFsConfigHandler({ configPath: undefined });
    const res = await h(post(CONFIG));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: false });
  });
});
